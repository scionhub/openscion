import { Piece } from "@web3-storage/data-segment";
import { privateKeyToAccount } from "viem/accounts";

export interface PDPOptions {
  baseUrl?: string; // retained for compatibility; unused when SDK is configured
  apiKey?: string; // retained for compatibility; unused when SDK is configured
  defaultProviderId?: string;
  privateKeyHex?: string; // '0x...' without 0x also accepted
  sourceTag?: string; // e.g., "openscion-poc-worker"
}

export interface ComputeCommPInput {
  // One of:
  bytesBase64?: string;
  contentUrl?: string;
  sizeBytes?: number;
}

export interface ComputeCommPResult {
  pieceCid: string;
  sizePaddedBytes?: number;
}

export interface StorePieceInput {
  pieceCid: string;
  providerId?: string;
  sizePaddedBytes?: number;
  bytesBase64?: string;
}

export interface StorePieceResult {
  dealId?: string;
  providerId?: string;
  state: "queued" | "storing" | "complete" | "error";
  error?: string;
}

/**
 * Minimal PDP adapter. For the POC this uses placeholder logic unless PDP_BASE_URL is set.
 * Replace the stubs with real Synapse SDK or PDP HTTP calls.
 */
export class PDPClient {
  private options: PDPOptions;
  private synapse?: any;
  private wantPrivateKey?: string;
  private sourceTag?: string;

  constructor(options: PDPOptions) {
    this.options = options;
    if (options.privateKeyHex) {
      const key = options.privateKeyHex.startsWith("0x")
        ? options.privateKeyHex
        : `0x${options.privateKeyHex}`;
      this.wantPrivateKey = key;
      this.sourceTag = options.sourceTag ?? "openscion-poc-worker";
    }
  }

  async computeCommP(input: ComputeCommPInput): Promise<ComputeCommPResult> {
    // Prefer real PieceCID using Synapse piece utils; fallback to content-url hashing placeholder.
    if (input.bytesBase64) {
      const data = decodeBase64(input.bytesBase64);
      const piece = Piece.fromPayload(data);
      return { pieceCid: piece.link.toString() };
    }
    if (input.contentUrl) {
      // Fetch content and compute PieceCID
      const resp = await fetch(input.contentUrl);
      if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
      const buf = new Uint8Array(await resp.arrayBuffer());
      const piece = Piece.fromPayload(buf);
      return { pieceCid: piece.link.toString() };
    }
    if (typeof input.sizeBytes === "number") {
      // Cannot compute without data; use deterministic placeholder for sizing only
      const pieceCid = await fakePieceCid(String(input.sizeBytes));
      return { pieceCid };
    }
    throw new Error("no input provided to compute CommP");
  }

  async storePiece(input: StorePieceInput): Promise<StorePieceResult> {
    // If Synapse is configured and bytes are provided, attempt a real upload.
    if (input.bytesBase64) {
      if (!this.synapse && this.wantPrivateKey) {
        await this.ensureSdk();
      }
    }
    if (this.synapse && input.bytesBase64) {
      try {
        const data = decodeBase64(input.bytesBase64);
        const result = await (this.synapse as any).storage.upload(data);
        return {
          dealId: undefined,
          providerId: input.providerId ?? this.options.defaultProviderId,
          state: result.complete ? "complete" : "storing"
        };
      } catch (e) {
        return {
          providerId: input.providerId ?? this.options.defaultProviderId,
          state: "error",
          error: (e as Error).message
        };
      }
    }
    // Mock mode (no keys or no bytes): record as queued.
    return {
      dealId: undefined,
      providerId: input.providerId ?? this.options.defaultProviderId,
      state: "queued"
    };
  }

  async downloadPiece(pieceCid: string): Promise<Uint8Array> {
    if (!this.synapse) {
      throw new Error("Synapse not configured");
    }
    // Synapse accepts string PieceCID
    return await (this.synapse as any).storage.download({ pieceCid });
  }

  private async ensureSdk(): Promise<void> {
    if (this.synapse || !this.wantPrivateKey) return;
    const sdkName = ["@filoz", "synapse-sdk"].join("/");
    // Use a non-literal specifier so the bundler does not try to include it.
    const mod = await import(sdkName).catch(() => {
      throw new Error("Synapse SDK is not available in this build");
    });
    const account = privateKeyToAccount(this.wantPrivateKey as `0x${string}`);
    this.synapse = (mod.Synapse as any).create({
      account,
      source: this.sourceTag ?? "openscion-poc-worker"
    }) as any;
  }
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function fakePieceCid(seed: string): Promise<string> {
  // Derive a deterministic placeholder looking like a CIDv1 base32 (not real).
  const data = new TextEncoder().encode(seed);
  if (
    !(
      typeof globalThis !== "undefined" &&
      typeof (globalThis as any).crypto !== "undefined" &&
      (globalThis as any).crypto.subtle &&
      typeof (globalThis as any).crypto.subtle.digest === "function"
    )
  ) {
    throw new Error("SubtleCrypto not available to compute placeholder CID");
  }
  const cryptoAny = (globalThis as any).crypto as any;
  // @ts-ignore Workers runtime provides SubtleCrypto
  const digest = await cryptoAny.subtle.digest(
    "SHA-256",
    data
  );
  const b32 = toBase32(new Uint8Array(digest)).toLowerCase();
  // Prefix with 'baga' (typical CIDv1 base32 prefix for certain multihashes) for cosmetics only.
  return `baga${b32.slice(4, 59)}`;
}

function toBase32(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += alphabet.charAt((value << (5 - bits)) & 31);
  }
  return output;
}
