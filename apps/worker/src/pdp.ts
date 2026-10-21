export interface PDPOptions {
  baseUrl?: string;
  apiKey?: string;
  defaultProviderId?: string;
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

  constructor(options: PDPOptions) {
    this.options = options;
  }

  async computeCommP(input: ComputeCommPInput): Promise<ComputeCommPResult> {
    if (this.options.baseUrl) {
      // TODO: Replace with real PDP endpoint invocation (Synapse SDK or HTTP)
      // This is intentionally a stub for the POC; documented in README.
    }
    const material =
      input.bytesBase64 ??
      input.contentUrl ??
      String(input.sizeBytes ?? Math.floor(Math.random() * 1e9));
    const pieceCid = await fakePieceCid(material);
    return { pieceCid };
  }

  async storePiece(input: StorePieceInput): Promise<StorePieceResult> {
    if (this.options.baseUrl) {
      // TODO: Replace with real PDP store call
    }
    // POC stub: pretend it queued successfully at a provider.
    return {
      dealId: undefined,
      providerId: input.providerId ?? this.options.defaultProviderId,
      state: "queued"
    };
  }
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
