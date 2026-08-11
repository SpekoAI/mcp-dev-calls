import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { loadEnv } from "../lib/env.js";

interface Flags {
  phone?: string;
  name?: string;
  yes: boolean;
}

export interface MeIo {
  ask(query: string): Promise<string>;
  write(message: string): void;
  /** stderr channel, so `speko me export > secret` captures only the blob. */
  warn?(message: string): void;
}

const defaultIo: MeIo = {
  ask(query) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(query, (answer) => (rl.close(), resolve(answer.trim()))));
  },
  write(message) {
    process.stdout.write(message);
  },
  warn(message) {
    process.stderr.write(message);
  },
};

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { yes: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--phone") flags.phone = argv[++i];
    else if (arg === "--name") flags.name = argv[++i];
    else if (arg === "--yes" || arg === "-y") flags.yes = true;
  }
  return flags;
}

function usage(io: MeIo): number {
  io.write(
    "Usage:\n" +
      "  speko me verify [--phone +1XXXXXXXXXX] [--name NAME]\n" +
      "  speko me status\n" +
      "  speko me export\n\n" +
      "Verification places one real, disclosed call and asks you to enter its six-digit code.\n" +
      "Export prints a portable owner blob for SPEKO_OWNER_PROFILE on headless installs; store it as a secret.\n",
  );
  return 2;
}

async function coreModule() {
  return import("@spekoai/mcp-calls-demo-server/core");
}

type CoreModule = Awaited<ReturnType<typeof coreModule>>;

export interface MeDeps {
  loadCore?: () => Promise<CoreModule>;
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
}

export async function runMe(argv: string[], io: MeIo = defaultIo, deps: MeDeps = {}): Promise<number> {
  const command = argv[0];
  if (command !== "verify" && command !== "status" && command !== "export") return usage(io);
  loadEnv();
  const env = deps.env ?? process.env;
  if ((env.SPEKO_MCP_SERVER_URL ?? "").trim()) {
    io.write(
      "call_me owner state belongs to the configured backing server. Run `speko status` for remote readiness, " +
        "or run `speko me verify`/`speko me status` on that server host with SPEKO_MCP_SERVER_URL unset.\n",
    );
    return 1;
  }
  const core = await (deps.loadCore ?? coreModule)();

  const envBlob = (env.SPEKO_OWNER_PROFILE ?? "").trim();

  if (command === "status") {
    const owner = core.readOwnerProfile();
    if (!owner) {
      io.write(
        envBlob
          ? "call_me is not set up yet. SPEKO_OWNER_PROFILE is set; the call backend materializes owner state from it at startup.\n"
          : "call_me is not set up. Run `speko me verify`.\n",
      );
      return 1;
    }
    let envSeed = false;
    if (envBlob) {
      try {
        const decoded = core.decodeOwnerProfileBlob(envBlob);
        envSeed = decoded.owner_phone === owner.owner_phone && decoded.instance_id === owner.instance_id;
      } catch {
        // An invalid blob cannot be the source of the active owner.
      }
    }
    io.write(
      `call_me owner is verified (phone ending ${owner.owner_phone.slice(-4)}, method ${owner.verify_method}).\n` +
        (envSeed ? "Owner source: the SPEKO_OWNER_PROFILE environment seed (`speko me export`).\n" : "") +
        "Local verification never relaxes DNC, rate caps, or quiet hours.\n",
    );
    return 0;
  }

  if (command === "export") {
    const owner = core.readOwnerProfile();
    if (!owner) {
      io.write("call_me has no verified owner to export. Run `speko me verify` on this machine first.\n");
      return 1;
    }
    (io.warn ?? defaultIo.warn)?.(
      "This blob is credential-equivalent for ringing this owner number: any install that sets SPEKO_OWNER_PROFILE with it gets a working call_me. Store it as a secret.\n",
    );
    io.write(`${core.encodeOwnerProfileBlob(owner)}\n`);
    return 0;
  }

  const flags = parseFlags(argv.slice(1));
  const key = (deps.apiKey ?? env.SPEKO_API_KEY ?? env.SPEKOAI_API_KEY ?? "")
    .trim()
    .replace(/^Bearer\s+/, "");
  if (!key) {
    io.write(
      "No Speko API key is available. Run `npx @spekoai/mcp-calls init` and choose owner verification, " +
        "or set SPEKO_API_KEY before running `speko me verify`.\n",
    );
    return 1;
  }

  const ownerName = (flags.name ?? (await io.ask("Owner name (used in the AI disclosure): "))).trim();
  const rawPhone = (flags.phone ?? (await io.ask("Owner phone (+1XXXXXXXXXX): "))).trim();
  const ownerPhone = core.normalizeNanpOwnerPhone(rawPhone);
  if (!ownerPhone) {
    io.write("Owner verification currently supports NANP numbers only in +1XXXXXXXXXX format.\n");
    return 1;
  }
  if (!ownerName) {
    io.write("Owner name is required for the non-removable AI disclosure.\n");
    return 1;
  }

  if (!flags.yes) {
    const approval = (await io.ask("Place one real verification call now? [y/N] ")).trim().toLowerCase();
    if (approval !== "y" && approval !== "yes") {
      io.write("Verification cancelled; no call was placed and owner state was not changed.\n");
      return 1;
    }
  }

  env.SPEKO_API_KEY = key;
  if (!(env.SPEKO_DIAL_TOKEN_SECRET ?? "").trim()) {
    env.SPEKO_DIAL_TOKEN_SECRET = randomBytes(32).toString("hex");
  }
  const cfg = core.loadConfig();
  const ctx = core.buildContext(cfg);
  const challenge = core.createOwnerVerificationChallenge();

  io.write("Placing the verification call. It counts against the ordinary owner-number call caps.\n");
  const result = await core.placeOwnerVerificationCall(
    {
      ownerPhone,
      ownerName,
      verificationCode: challenge.code,
      maxDurationSeconds: 60,
    },
    { client: ctx.client, cfg: ctx.cfg, bearerHash: ctx.bearerHash },
  );
  if (!result.call_id || result.status === "not_placed" || result.status === "not_connected") {
    io.write(`Verification call did not reach the code-entry step (status: ${result.status}). Owner state was not changed.\n`);
    return 1;
  }

  while (challenge.attempts_remaining > 0) {
    const code = await io.ask(`Enter the six-digit code (${challenge.attempts_remaining} attempt(s) left): `);
    const checked = core.checkOwnerVerificationCode(challenge, code);
    if (checked === "verified") {
      const profile = core.writeOwnerProfile({ ownerPhone, ownerName });
      io.write(
        `Owner phone ending ${profile.owner_phone.slice(-4)} is verified for call_me. ` +
          "DNC, ordinary rate caps, and quiet hours still apply to every owner call.\n",
      );
      return 0;
    }
    if (checked === "expired") {
      io.write("The verification code expired. Owner state was not changed; run `speko me verify` again.\n");
      return 1;
    }
    if (checked === "attempts_exhausted") break;
    io.write("That code did not match.\n");
  }
  io.write("Verification attempts exhausted. Owner state was not changed.\n");
  return 1;
}
