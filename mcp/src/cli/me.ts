import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { loadEnv } from "../lib/env.js";

interface Flags {
  token?: string;
  phone?: string;
  name?: string;
  yes: boolean;
}

export interface MeIo {
  ask(query: string): Promise<string>;
  write(message: string): void;
}

const defaultIo: MeIo = {
  ask(query) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(query, (answer) => (rl.close(), resolve(answer.trim()))));
  },
  write(message) {
    process.stdout.write(message);
  },
};

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { yes: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--token") flags.token = argv[++i];
    else if (arg === "--phone") flags.phone = argv[++i];
    else if (arg === "--name") flags.name = argv[++i];
    else if (arg === "--yes" || arg === "-y") flags.yes = true;
  }
  return flags;
}

function usage(io: MeIo): number {
  io.write(
    "Usage:\n" +
      "  speko me verify [--phone +1XXXXXXXXXX] [--name NAME] [--token sk_...]\n" +
      "  speko me status\n\n" +
      "Verification places one real, disclosed call and asks you to enter its six-digit code.\n",
  );
  return 2;
}

async function coreModule() {
  return import("@spekoai/mcp-calls-demo-server/core");
}

type CoreModule = Awaited<ReturnType<typeof coreModule>>;

export interface MeDeps {
  loadCore?: () => Promise<CoreModule>;
}

export async function runMe(argv: string[], io: MeIo = defaultIo, deps: MeDeps = {}): Promise<number> {
  const command = argv[0];
  if (command !== "verify" && command !== "status") return usage(io);
  loadEnv();
  const core = await (deps.loadCore ?? coreModule)();

  if (command === "status") {
    const owner = core.readOwnerProfile();
    if (!owner) {
      io.write("call_me is not set up. Run `speko me verify`.\n");
      return 1;
    }
    io.write(
      `call_me owner is verified (phone ending ${owner.owner_phone.slice(-4)}, method ${owner.verify_method}).\n` +
        "Local verification never relaxes DNC, rate caps, or quiet hours.\n",
    );
    return 0;
  }

  const flags = parseFlags(argv.slice(1));
  const key = (flags.token ?? process.env.SPEKO_API_KEY ?? process.env.SPEKOAI_API_KEY ?? "")
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

  process.env.SPEKO_API_KEY = key;
  if (!(process.env.SPEKO_DIAL_TOKEN_SECRET ?? "").trim()) {
    process.env.SPEKO_DIAL_TOKEN_SECRET = randomBytes(32).toString("hex");
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
