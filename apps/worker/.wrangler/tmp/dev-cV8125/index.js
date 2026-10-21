var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __export = (target, all) => {
  for (var name5 in all)
    __defProp(target, name5, { get: all[name5], enumerable: true });
};

// .wrangler/tmp/bundle-Hld4GC/strip-cf-connecting-ip-header.js
function stripCfConnectingIPHeader(input, init) {
  const request = new Request(input, init);
  request.headers.delete("CF-Connecting-IP");
  return request;
}
__name(stripCfConnectingIPHeader, "stripCfConnectingIPHeader");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    return Reflect.apply(target, thisArg, [
      stripCfConnectingIPHeader.apply(null, argArray)
    ]);
  }
});

// src/db.ts
async function d1All(db, sql, params = []) {
  const stmt = db.prepare(sql);
  const bound = params.length > 0 ? stmt.bind(...params.map((p) => p === void 0 ? null : p)) : stmt;
  const res = await bound.all();
  if (!res.success) {
    throw new Error(res.error || "D1 query failed");
  }
  return res.results ?? [];
}
__name(d1All, "d1All");
async function d1Run(db, sql, params = []) {
  const stmt = db.prepare(sql);
  const bound = params.length > 0 ? stmt.bind(...params.map((p) => p === void 0 ? null : p)) : stmt;
  const res = await bound.run();
  if (!res.success) {
    throw new Error(res.error || "D1 exec failed");
  }
}
__name(d1Run, "d1Run");
function nowMs() {
  return Date.now();
}
__name(nowMs, "nowMs");
function uuid() {
  const hasCrypto = typeof globalThis !== "undefined" && typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.getRandomValues === "function";
  const rnd = hasCrypto ? globalThis.crypto.getRandomValues(new Uint8Array(16)) : Uint8Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  rnd[6] = rnd[6] & 15 | 64;
  rnd[8] = rnd[8] & 63 | 128;
  const hex = Array.from(rnd, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
__name(uuid, "uuid");

// node_modules/@web3-storage/data-segment/src/constant.js
var BITS_PER_BYTE = 8;
var FRS_PER_QUAD = 4;
var LEAFS_PER_QUAD = (
  /** @type {4n} */
  BigInt(FRS_PER_QUAD)
);
var IN_BITS_FR = 254;
var OUT_BITS_FR = 256;
var IN_BYTES_PER_QUAD = (
  /** @type {127} */
  FRS_PER_QUAD * IN_BITS_FR / BITS_PER_BYTE
);
var OUT_BYTES_PER_QUAD = (
  /** @type {128} */
  FRS_PER_QUAD * OUT_BITS_FR / BITS_PER_BYTE
);
var PADDED_BYTES_PER_QUAD = (
  /** @type {127n} */
  BigInt(IN_BYTES_PER_QUAD)
);
var EXPANDED_BYTES_PER_QUAD = (
  /** @type {128n} */
  BigInt(OUT_BYTES_PER_QUAD)
);
var BYTES_PER_FR = (
  /** @type {32} */
  OUT_BYTES_PER_QUAD / FRS_PER_QUAD
);
var FR_RATIO = IN_BITS_FR / OUT_BITS_FR;
var NODE_SIZE = (
  /** @type {32} */
  OUT_BYTES_PER_QUAD / FRS_PER_QUAD
);
var EXPANDED_BYTES_PER_NODE = (
  /** @type {32n} */
  BigInt(NODE_SIZE)
);
var MIN_PAYLOAD_SIZE = 2 * NODE_SIZE + 1;

// node_modules/@web3-storage/data-segment/src/node.js
var from = /* @__PURE__ */ __name((bytes2) => {
  if (bytes2 instanceof Uint8Array) {
    if (bytes2.length > NODE_SIZE) {
      return bytes2.subarray(0, NODE_SIZE);
    } else if (bytes2.length == NODE_SIZE) {
      return bytes2;
    }
  }
  const node = new Uint8Array(NODE_SIZE);
  node.set([...bytes2]);
  return node;
}, "from");
var empty = /* @__PURE__ */ __name(() => EMPTY, "empty");
var EMPTY = from(new Uint8Array(NODE_SIZE).fill(0));
Object.freeze(EMPTY.buffer);

// node_modules/multiformats/dist/src/bytes.js
var empty2 = new Uint8Array(0);
function equals(aa, bb) {
  if (aa === bb) {
    return true;
  }
  if (aa.byteLength !== bb.byteLength) {
    return false;
  }
  for (let ii = 0; ii < aa.byteLength; ii++) {
    if (aa[ii] !== bb[ii]) {
      return false;
    }
  }
  return true;
}
__name(equals, "equals");
function coerce(o) {
  if (o instanceof Uint8Array && o.constructor.name === "Uint8Array") {
    return o;
  }
  if (o instanceof ArrayBuffer) {
    return new Uint8Array(o);
  }
  if (ArrayBuffer.isView(o)) {
    return new Uint8Array(o.buffer, o.byteOffset, o.byteLength);
  }
  throw new Error("Unknown type, must be binary type");
}
__name(coerce, "coerce");

// node_modules/@web3-storage/data-segment/src/ipld/sha256.js
var sha256_exports = {};
__export(sha256_exports, {
  code: () => code2,
  digest: () => digest,
  name: () => name,
  size: () => size
});

// node_modules/sync-multihash-sha2/src/sha256/web.js
var web_exports = {};
__export(web_exports, {
  code: () => code,
  digest: () => digest,
  name: () => name,
  size: () => size
});

// node_modules/@noble/hashes/esm/_assert.js
function bytes(b, ...lengths) {
  if (!(b instanceof Uint8Array))
    throw new Error("Expected Uint8Array");
  if (lengths.length > 0 && !lengths.includes(b.length))
    throw new Error(`Expected Uint8Array of length ${lengths}, not of length=${b.length}`);
}
__name(bytes, "bytes");
function exists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw new Error("Hash#digest() has already been called");
}
__name(exists, "exists");
function output(out, instance) {
  bytes(out);
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error(`digestInto() expects output buffer of length at least ${min}`);
  }
}
__name(output, "output");

// node_modules/@noble/hashes/esm/utils.js
var u8a = /* @__PURE__ */ __name((a) => a instanceof Uint8Array, "u8a");
var createView = /* @__PURE__ */ __name((arr) => new DataView(arr.buffer, arr.byteOffset, arr.byteLength), "createView");
var rotr = /* @__PURE__ */ __name((word, shift) => word << 32 - shift | word >>> shift, "rotr");
var isLE = new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68;
if (!isLE)
  throw new Error("Non little-endian hardware is not supported");
function utf8ToBytes(str) {
  if (typeof str !== "string")
    throw new Error(`utf8ToBytes expected string, got ${typeof str}`);
  return new Uint8Array(new TextEncoder().encode(str));
}
__name(utf8ToBytes, "utf8ToBytes");
function toBytes(data) {
  if (typeof data === "string")
    data = utf8ToBytes(data);
  if (!u8a(data))
    throw new Error(`expected Uint8Array, got ${typeof data}`);
  return data;
}
__name(toBytes, "toBytes");
var Hash = class {
  // Safe version that clones internal state
  clone() {
    return this._cloneInto();
  }
};
__name(Hash, "Hash");
var toStr = {}.toString;
function wrapConstructor(hashCons) {
  const hashC = /* @__PURE__ */ __name((msg) => hashCons().update(toBytes(msg)).digest(), "hashC");
  const tmp = hashCons();
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = () => hashCons();
  return hashC;
}
__name(wrapConstructor, "wrapConstructor");

// node_modules/@noble/hashes/esm/_sha2.js
function setBigUint64(view, byteOffset, value, isLE3) {
  if (typeof view.setBigUint64 === "function")
    return view.setBigUint64(byteOffset, value, isLE3);
  const _32n2 = BigInt(32);
  const _u32_max = BigInt(4294967295);
  const wh = Number(value >> _32n2 & _u32_max);
  const wl = Number(value & _u32_max);
  const h = isLE3 ? 4 : 0;
  const l = isLE3 ? 0 : 4;
  view.setUint32(byteOffset + h, wh, isLE3);
  view.setUint32(byteOffset + l, wl, isLE3);
}
__name(setBigUint64, "setBigUint64");
var SHA2 = class extends Hash {
  constructor(blockLen, outputLen, padOffset, isLE3) {
    super();
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE3;
    this.finished = false;
    this.length = 0;
    this.pos = 0;
    this.destroyed = false;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    exists(this);
    const { view, buffer: buffer2, blockLen } = this;
    data = toBytes(data);
    const len = data.length;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView2 = createView(data);
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(dataView2, pos);
        continue;
      }
      buffer2.set(data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
      }
    }
    this.length += data.length;
    this.roundClean();
    return this;
  }
  digestInto(out) {
    exists(this);
    output(out, this);
    this.finished = true;
    const { buffer: buffer2, view, blockLen, isLE: isLE3 } = this;
    let { pos } = this;
    buffer2[pos++] = 128;
    this.buffer.subarray(pos).fill(0);
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      pos = 0;
    }
    for (let i = pos; i < blockLen; i++)
      buffer2[i] = 0;
    setBigUint64(view, blockLen - 8, BigInt(this.length * 8), isLE3);
    this.process(view, 0);
    const oview = createView(out);
    const len = this.outputLen;
    if (len % 4)
      throw new Error("_sha2: outputLen should be aligned to 32bit");
    const outLen = len / 4;
    const state = this.get();
    if (outLen > state.length)
      throw new Error("_sha2: outputLen bigger than state");
    for (let i = 0; i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE3);
  }
  digest() {
    const { buffer: buffer2, outputLen } = this;
    this.digestInto(buffer2);
    const res = buffer2.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneInto(to) {
    to || (to = new this.constructor());
    to.set(...this.get());
    const { blockLen, buffer: buffer2, length: length2, finished, destroyed, pos } = this;
    to.length = length2;
    to.pos = pos;
    to.finished = finished;
    to.destroyed = destroyed;
    if (length2 % blockLen)
      to.buffer.set(buffer2);
    return to;
  }
};
__name(SHA2, "SHA2");

// node_modules/@noble/hashes/esm/sha256.js
var Chi = /* @__PURE__ */ __name((a, b, c) => a & b ^ ~a & c, "Chi");
var Maj = /* @__PURE__ */ __name((a, b, c) => a & b ^ a & c ^ b & c, "Maj");
var SHA256_K = /* @__PURE__ */ new Uint32Array([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var IV = /* @__PURE__ */ new Uint32Array([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);
var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
var SHA256 = class extends SHA2 {
  constructor() {
    super(64, 32, 8, false);
    this.A = IV[0] | 0;
    this.B = IV[1] | 0;
    this.C = IV[2] | 0;
    this.D = IV[3] | 0;
    this.E = IV[4] | 0;
    this.F = IV[5] | 0;
    this.G = IV[6] | 0;
    this.H = IV[7] | 0;
  }
  get() {
    const { A, B, C, D, E, F, G, H } = this;
    return [A, B, C, D, E, F, G, H];
  }
  // prettier-ignore
  set(A, B, C, D, E, F, G, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G | 0;
    this.H = H | 0;
  }
  process(view, offset2) {
    for (let i = 0; i < 16; i++, offset2 += 4)
      SHA256_W[i] = view.getUint32(offset2, false);
    for (let i = 16; i < 64; i++) {
      const W15 = SHA256_W[i - 15];
      const W2 = SHA256_W[i - 2];
      const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
      const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
    }
    let { A, B, C, D, E, F, G, H } = this;
    for (let i = 0; i < 64; i++) {
      const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
      const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = sigma0 + Maj(A, B, C) | 0;
      H = G;
      G = F;
      F = E;
      E = D + T1 | 0;
      D = C;
      C = B;
      B = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B = B + this.B | 0;
    C = C + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G = G + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B, C, D, E, F, G, H);
  }
  roundClean() {
    SHA256_W.fill(0);
  }
  destroy() {
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    this.buffer.fill(0);
  }
};
__name(SHA256, "SHA256");
var sha256 = /* @__PURE__ */ wrapConstructor(() => new SHA256());

// node_modules/sync-multihash-sha2/src/sha256/digest.js
var name = "sha2-256";
var code = 18;
var size = 32;
var prefix = new Uint8Array([18, 32]);
var Digest = class {
  /**
   * @param {Uint8Array} bytes
   */
  constructor(bytes2) {
    this.code = code;
    this.name = name;
    this.bytes = bytes2;
    this.size = size;
    this.digest = bytes2.subarray(2);
  }
};
__name(Digest, "Digest");

// node_modules/sync-multihash-sha2/src/sha256/web.js
var digest = /* @__PURE__ */ __name((payload) => {
  const digest3 = new Uint8Array(prefix.length + size);
  digest3.set(prefix, 0);
  digest3.set(sha256(payload), prefix.length);
  return new Digest(digest3);
}, "digest");

// node_modules/@web3-storage/data-segment/src/ipld/sha256.js
var code2 = code;

// node_modules/cborg/lib/is.js
var objectTypeNames = [
  "Object",
  // for Object.create(null) and other non-plain objects
  "RegExp",
  "Date",
  "Error",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Promise",
  "URL",
  "HTMLElement",
  "Int8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "Tagged"
];
function is(value) {
  if (value === null) {
    return "null";
  }
  if (value === void 0) {
    return "undefined";
  }
  if (value === true || value === false) {
    return "boolean";
  }
  const typeOf = typeof value;
  if (typeOf === "string" || typeOf === "number" || typeOf === "bigint" || typeOf === "symbol") {
    return typeOf;
  }
  if (typeOf === "function") {
    return "Function";
  }
  if (Array.isArray(value)) {
    return "Array";
  }
  if (value instanceof Uint8Array) {
    return "Uint8Array";
  }
  if (value.constructor === Object) {
    return "Object";
  }
  const objectType = getObjectType(value);
  if (objectType) {
    return objectType;
  }
  return "Object";
}
__name(is, "is");
function getObjectType(value) {
  const objectTypeName = Object.prototype.toString.call(value).slice(8, -1);
  if (objectTypeNames.includes(objectTypeName)) {
    return objectTypeName;
  }
  return void 0;
}
__name(getObjectType, "getObjectType");

// node_modules/cborg/lib/token.js
var Type = class {
  /**
   * @param {number} major
   * @param {string} name
   * @param {boolean} terminal
   */
  constructor(major, name5, terminal) {
    this.major = major;
    this.majorEncoded = major << 5;
    this.name = name5;
    this.terminal = terminal;
  }
  toString() {
    return `Type[${this.major}].${this.name}`;
  }
  /**
   * @param {Type} typ
   * @returns {number}
   */
  compare(typ) {
    return this.major < typ.major ? -1 : this.major > typ.major ? 1 : 0;
  }
  /**
   * Check equality between two Type instances. Safe to use across different
   * copies of the Type class (e.g., when bundlers duplicate the module).
   * (major, name) uniquely identifies a Type; terminal is implied by these.
   * @param {Type} a
   * @param {Type} b
   * @returns {boolean}
   */
  static equals(a, b) {
    return a === b || a.major === b.major && a.name === b.name;
  }
};
__name(Type, "Type");
Type.uint = new Type(0, "uint", true);
Type.negint = new Type(1, "negint", true);
Type.bytes = new Type(2, "bytes", true);
Type.string = new Type(3, "string", true);
Type.array = new Type(4, "array", false);
Type.map = new Type(5, "map", false);
Type.tag = new Type(6, "tag", false);
Type.float = new Type(7, "float", true);
Type.false = new Type(7, "false", true);
Type.true = new Type(7, "true", true);
Type.null = new Type(7, "null", true);
Type.undefined = new Type(7, "undefined", true);
Type.break = new Type(7, "break", true);
var Token = class {
  /**
   * @param {Type} type
   * @param {any} [value]
   * @param {number} [encodedLength]
   */
  constructor(type, value, encodedLength) {
    this.type = type;
    this.value = value;
    this.encodedLength = encodedLength;
    this.encodedBytes = void 0;
    this.byteValue = void 0;
  }
  toString() {
    return `Token[${this.type}].${this.value}`;
  }
};
__name(Token, "Token");

// node_modules/cborg/lib/byte-utils.js
var useBuffer = globalThis.process && // @ts-ignore
!globalThis.process.browser && // @ts-ignore
globalThis.Buffer && // @ts-ignore
typeof globalThis.Buffer.isBuffer === "function";
var textEncoder = new TextEncoder();
function isBuffer(buf) {
  return useBuffer && globalThis.Buffer.isBuffer(buf);
}
__name(isBuffer, "isBuffer");
function asU8A(buf) {
  if (!(buf instanceof Uint8Array)) {
    return Uint8Array.from(buf);
  }
  return isBuffer(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : buf;
}
__name(asU8A, "asU8A");
var FROM_STRING_THRESHOLD_BUFFER = 24;
var FROM_STRING_THRESHOLD_TEXTENCODER = 200;
var fromString = useBuffer ? (
  // eslint-disable-line operator-linebreak
  /**
   * @param {string} string
   */
  (string) => {
    return string.length >= FROM_STRING_THRESHOLD_BUFFER ? (
      // eslint-disable-line operator-linebreak
      // @ts-ignore
      globalThis.Buffer.from(string)
    ) : utf8ToBytes2(string);
  }
) : (
  // eslint-disable-line operator-linebreak
  /**
   * @param {string} string
   */
  (string) => {
    return string.length >= FROM_STRING_THRESHOLD_TEXTENCODER ? textEncoder.encode(string) : utf8ToBytes2(string);
  }
);
var fromArray = /* @__PURE__ */ __name((arr) => {
  return Uint8Array.from(arr);
}, "fromArray");
var slice = useBuffer ? (
  // eslint-disable-line operator-linebreak
  /**
   * @param {Uint8Array} bytes
   * @param {number} start
   * @param {number} end
   */
  // Buffer.slice() returns a view, not a copy, so we need special handling
  (bytes2, start, end) => {
    if (isBuffer(bytes2)) {
      return new Uint8Array(bytes2.subarray(start, end));
    }
    return bytes2.slice(start, end);
  }
) : (
  // eslint-disable-line operator-linebreak
  /**
   * @param {Uint8Array} bytes
   * @param {number} start
   * @param {number} end
   */
  (bytes2, start, end) => {
    return bytes2.slice(start, end);
  }
);
var concat = useBuffer ? (
  // eslint-disable-line operator-linebreak
  /**
   * @param {ByteView[]} chunks
   * @param {number} length
   * @returns {AllocatedByteView}
   */
  (chunks, length2) => {
    chunks = chunks.map((c) => c instanceof Uint8Array ? c : (
      // eslint-disable-line operator-linebreak
      // @ts-ignore
      globalThis.Buffer.from(c)
    ));
    return (
      /** @type {AllocatedByteView} */
      asU8A(globalThis.Buffer.concat(chunks, length2))
    );
  }
) : (
  // eslint-disable-line operator-linebreak
  /**
   * @param {ByteView[]} chunks
   * @param {number} length
   * @returns {AllocatedByteView}
   */
  (chunks, length2) => {
    const out = new Uint8Array(length2);
    let off = 0;
    for (let b of chunks) {
      if (off + b.length > out.length) {
        b = b.subarray(0, out.length - off);
      }
      out.set(b, off);
      off += b.length;
    }
    return out;
  }
);
var alloc = useBuffer ? (
  // eslint-disable-line operator-linebreak
  /**
   * @param {number} size
   * @returns {AllocatedByteView}
   */
  (size3) => {
    return globalThis.Buffer.allocUnsafe(size3);
  }
) : (
  // eslint-disable-line operator-linebreak
  /**
   * @param {number} size
   * @returns {AllocatedByteView}
   */
  (size3) => {
    return new Uint8Array(size3);
  }
);
function compare(b1, b2) {
  if (isBuffer(b1) && isBuffer(b2)) {
    return b1.compare(b2);
  }
  for (let i = 0; i < b1.length; i++) {
    if (b1[i] === b2[i]) {
      continue;
    }
    return b1[i] < b2[i] ? -1 : 1;
  }
  return 0;
}
__name(compare, "compare");
function utf8ToBytes2(str) {
  const out = [];
  let p = 0;
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 128) {
      out[p++] = c;
    } else if (c < 2048) {
      out[p++] = c >> 6 | 192;
      out[p++] = c & 63 | 128;
    } else if ((c & 64512) === 55296 && i + 1 < str.length && (str.charCodeAt(i + 1) & 64512) === 56320) {
      c = 65536 + ((c & 1023) << 10) + (str.charCodeAt(++i) & 1023);
      out[p++] = c >> 18 | 240;
      out[p++] = c >> 12 & 63 | 128;
      out[p++] = c >> 6 & 63 | 128;
      out[p++] = c & 63 | 128;
    } else {
      if (c >= 55296 && c <= 57343) {
        c = 65533;
      }
      out[p++] = c >> 12 | 224;
      out[p++] = c >> 6 & 63 | 128;
      out[p++] = c & 63 | 128;
    }
  }
  return out;
}
__name(utf8ToBytes2, "utf8ToBytes");

// node_modules/cborg/lib/bl.js
var defaultChunkSize = 256;
var Bl = class {
  /**
   * @param {number} [chunkSize]
   */
  constructor(chunkSize = defaultChunkSize) {
    this.chunkSize = chunkSize;
    this.cursor = 0;
    this.maxCursor = -1;
    this.chunks = [];
    this._initReuseChunk = null;
  }
  reset() {
    this.cursor = 0;
    this.maxCursor = -1;
    if (this.chunks.length) {
      this.chunks = [];
    }
    if (this._initReuseChunk !== null) {
      this.chunks.push(this._initReuseChunk);
      this.maxCursor = this._initReuseChunk.length - 1;
    }
  }
  /**
   * @param {ByteView|number[]} bytes
   */
  push(bytes2) {
    let topChunk = this.chunks[this.chunks.length - 1];
    const newMax = this.cursor + bytes2.length;
    if (newMax <= this.maxCursor + 1) {
      const chunkPos = topChunk.length - (this.maxCursor - this.cursor) - 1;
      topChunk.set(bytes2, chunkPos);
    } else {
      if (topChunk) {
        const chunkPos = topChunk.length - (this.maxCursor - this.cursor) - 1;
        if (chunkPos < topChunk.length) {
          this.chunks[this.chunks.length - 1] = topChunk.subarray(0, chunkPos);
          this.maxCursor = this.cursor - 1;
        }
      }
      if (bytes2.length < 64 && bytes2.length < this.chunkSize) {
        topChunk = alloc(this.chunkSize);
        this.chunks.push(topChunk);
        this.maxCursor += topChunk.length;
        if (this._initReuseChunk === null) {
          this._initReuseChunk = topChunk;
        }
        topChunk.set(bytes2, 0);
      } else {
        this.chunks.push(bytes2);
        this.maxCursor += bytes2.length;
      }
    }
    this.cursor += bytes2.length;
  }
  /**
   * @param {boolean} [reset]
   * @returns {AllocatedByteView}
   */
  toBytes(reset = false) {
    let byts;
    if (this.chunks.length === 1) {
      const chunk = this.chunks[0];
      if (reset && this.cursor > chunk.length / 2) {
        byts = this.cursor === chunk.length ? chunk : chunk.subarray(0, this.cursor);
        this._initReuseChunk = null;
        this.chunks = [];
      } else {
        byts = slice(chunk, 0, this.cursor);
      }
    } else {
      byts = concat(this.chunks, this.cursor);
    }
    if (reset) {
      this.reset();
    }
    return byts;
  }
};
__name(Bl, "Bl");
var U8Bl = class {
  /**
   * @param {Uint8Array<T>} dest
   */
  constructor(dest) {
    this.dest = dest;
    this.cursor = 0;
    this.chunks = [dest];
  }
  reset() {
    this.cursor = 0;
  }
  /**
   * @param {ByteView|number[]} bytes
   */
  push(bytes2) {
    if (this.cursor + bytes2.length > this.dest.length) {
      throw new Error("write out of bounds, destination buffer is too small");
    }
    this.dest.set(bytes2, this.cursor);
    this.cursor += bytes2.length;
  }
  /**
   * @param {boolean} [reset]
   * @returns {Uint8Array<T>}
   */
  toBytes(reset = false) {
    const byts = this.dest.subarray(0, this.cursor);
    if (reset) {
      this.reset();
    }
    return byts;
  }
};
__name(U8Bl, "U8Bl");

// node_modules/cborg/lib/common.js
var decodeErrPrefix = "CBOR decode error:";
var encodeErrPrefix = "CBOR encode error:";
var uintMinorPrefixBytes = [];
uintMinorPrefixBytes[23] = 1;
uintMinorPrefixBytes[24] = 2;
uintMinorPrefixBytes[25] = 3;
uintMinorPrefixBytes[26] = 5;
uintMinorPrefixBytes[27] = 9;
function assertEnoughData(data, pos, need) {
  if (data.length - pos < need) {
    throw new Error(`${decodeErrPrefix} not enough data for type`);
  }
}
__name(assertEnoughData, "assertEnoughData");

// node_modules/cborg/lib/0uint.js
var uintBoundaries = [24, 256, 65536, 4294967296, BigInt("18446744073709551616")];
function readUint8(data, offset2, options) {
  assertEnoughData(data, offset2, 1);
  const value = data[offset2];
  if (options.strict === true && value < uintBoundaries[0]) {
    throw new Error(`${decodeErrPrefix} integer encoded in more bytes than necessary (strict decode)`);
  }
  return value;
}
__name(readUint8, "readUint8");
function readUint16(data, offset2, options) {
  assertEnoughData(data, offset2, 2);
  const value = data[offset2] << 8 | data[offset2 + 1];
  if (options.strict === true && value < uintBoundaries[1]) {
    throw new Error(`${decodeErrPrefix} integer encoded in more bytes than necessary (strict decode)`);
  }
  return value;
}
__name(readUint16, "readUint16");
function readUint32(data, offset2, options) {
  assertEnoughData(data, offset2, 4);
  const value = data[offset2] * 16777216 + (data[offset2 + 1] << 16) + (data[offset2 + 2] << 8) + data[offset2 + 3];
  if (options.strict === true && value < uintBoundaries[2]) {
    throw new Error(`${decodeErrPrefix} integer encoded in more bytes than necessary (strict decode)`);
  }
  return value;
}
__name(readUint32, "readUint32");
function readUint64(data, offset2, options) {
  assertEnoughData(data, offset2, 8);
  const hi = data[offset2] * 16777216 + (data[offset2 + 1] << 16) + (data[offset2 + 2] << 8) + data[offset2 + 3];
  const lo = data[offset2 + 4] * 16777216 + (data[offset2 + 5] << 16) + (data[offset2 + 6] << 8) + data[offset2 + 7];
  const value = (BigInt(hi) << BigInt(32)) + BigInt(lo);
  if (options.strict === true && value < uintBoundaries[3]) {
    throw new Error(`${decodeErrPrefix} integer encoded in more bytes than necessary (strict decode)`);
  }
  if (value <= Number.MAX_SAFE_INTEGER) {
    return Number(value);
  }
  if (options.allowBigInt === true) {
    return value;
  }
  throw new Error(`${decodeErrPrefix} integers outside of the safe integer range are not supported`);
}
__name(readUint64, "readUint64");
function decodeUint8(data, pos, _minor, options) {
  return new Token(Type.uint, readUint8(data, pos + 1, options), 2);
}
__name(decodeUint8, "decodeUint8");
function decodeUint16(data, pos, _minor, options) {
  return new Token(Type.uint, readUint16(data, pos + 1, options), 3);
}
__name(decodeUint16, "decodeUint16");
function decodeUint32(data, pos, _minor, options) {
  return new Token(Type.uint, readUint32(data, pos + 1, options), 5);
}
__name(decodeUint32, "decodeUint32");
function decodeUint64(data, pos, _minor, options) {
  return new Token(Type.uint, readUint64(data, pos + 1, options), 9);
}
__name(decodeUint64, "decodeUint64");
function encodeUint(writer, token) {
  return encodeUintValue(writer, 0, token.value);
}
__name(encodeUint, "encodeUint");
function encodeUintValue(writer, major, uint) {
  if (uint < uintBoundaries[0]) {
    const nuint = Number(uint);
    writer.push([major | nuint]);
  } else if (uint < uintBoundaries[1]) {
    const nuint = Number(uint);
    writer.push([major | 24, nuint]);
  } else if (uint < uintBoundaries[2]) {
    const nuint = Number(uint);
    writer.push([major | 25, nuint >>> 8, nuint & 255]);
  } else if (uint < uintBoundaries[3]) {
    const nuint = Number(uint);
    writer.push([major | 26, nuint >>> 24 & 255, nuint >>> 16 & 255, nuint >>> 8 & 255, nuint & 255]);
  } else {
    const buint = BigInt(uint);
    if (buint < uintBoundaries[4]) {
      const set = [major | 27, 0, 0, 0, 0, 0, 0, 0];
      let lo = Number(buint & BigInt(4294967295));
      let hi = Number(buint >> BigInt(32) & BigInt(4294967295));
      set[8] = lo & 255;
      lo = lo >> 8;
      set[7] = lo & 255;
      lo = lo >> 8;
      set[6] = lo & 255;
      lo = lo >> 8;
      set[5] = lo & 255;
      set[4] = hi & 255;
      hi = hi >> 8;
      set[3] = hi & 255;
      hi = hi >> 8;
      set[2] = hi & 255;
      hi = hi >> 8;
      set[1] = hi & 255;
      writer.push(set);
    } else {
      throw new Error(`${decodeErrPrefix} encountered BigInt larger than allowable range`);
    }
  }
}
__name(encodeUintValue, "encodeUintValue");
encodeUint.encodedSize = /* @__PURE__ */ __name(function encodedSize(token) {
  return encodeUintValue.encodedSize(token.value);
}, "encodedSize");
encodeUintValue.encodedSize = /* @__PURE__ */ __name(function encodedSize2(uint) {
  if (uint < uintBoundaries[0]) {
    return 1;
  }
  if (uint < uintBoundaries[1]) {
    return 2;
  }
  if (uint < uintBoundaries[2]) {
    return 3;
  }
  if (uint < uintBoundaries[3]) {
    return 5;
  }
  return 9;
}, "encodedSize");
encodeUint.compareTokens = /* @__PURE__ */ __name(function compareTokens(tok1, tok2) {
  return tok1.value < tok2.value ? -1 : tok1.value > tok2.value ? 1 : 0;
}, "compareTokens");

// node_modules/cborg/lib/1negint.js
function decodeNegint8(data, pos, _minor, options) {
  return new Token(Type.negint, -1 - readUint8(data, pos + 1, options), 2);
}
__name(decodeNegint8, "decodeNegint8");
function decodeNegint16(data, pos, _minor, options) {
  return new Token(Type.negint, -1 - readUint16(data, pos + 1, options), 3);
}
__name(decodeNegint16, "decodeNegint16");
function decodeNegint32(data, pos, _minor, options) {
  return new Token(Type.negint, -1 - readUint32(data, pos + 1, options), 5);
}
__name(decodeNegint32, "decodeNegint32");
var neg1b = BigInt(-1);
var pos1b = BigInt(1);
function decodeNegint64(data, pos, _minor, options) {
  const int = readUint64(data, pos + 1, options);
  if (typeof int !== "bigint") {
    const value = -1 - int;
    if (value >= Number.MIN_SAFE_INTEGER) {
      return new Token(Type.negint, value, 9);
    }
  }
  if (options.allowBigInt !== true) {
    throw new Error(`${decodeErrPrefix} integers outside of the safe integer range are not supported`);
  }
  return new Token(Type.negint, neg1b - BigInt(int), 9);
}
__name(decodeNegint64, "decodeNegint64");
function encodeNegint(writer, token) {
  const negint = token.value;
  const unsigned = typeof negint === "bigint" ? negint * neg1b - pos1b : negint * -1 - 1;
  encodeUintValue(writer, token.type.majorEncoded, unsigned);
}
__name(encodeNegint, "encodeNegint");
encodeNegint.encodedSize = /* @__PURE__ */ __name(function encodedSize3(token) {
  const negint = token.value;
  const unsigned = typeof negint === "bigint" ? negint * neg1b - pos1b : negint * -1 - 1;
  if (unsigned < uintBoundaries[0]) {
    return 1;
  }
  if (unsigned < uintBoundaries[1]) {
    return 2;
  }
  if (unsigned < uintBoundaries[2]) {
    return 3;
  }
  if (unsigned < uintBoundaries[3]) {
    return 5;
  }
  return 9;
}, "encodedSize");
encodeNegint.compareTokens = /* @__PURE__ */ __name(function compareTokens2(tok1, tok2) {
  return tok1.value < tok2.value ? 1 : tok1.value > tok2.value ? -1 : 0;
}, "compareTokens");

// node_modules/cborg/lib/2bytes.js
function toToken(data, pos, prefix2, length2) {
  assertEnoughData(data, pos, prefix2 + length2);
  const buf = data.slice(pos + prefix2, pos + prefix2 + length2);
  return new Token(Type.bytes, buf, prefix2 + length2);
}
__name(toToken, "toToken");
function decodeBytesCompact(data, pos, minor, _options) {
  return toToken(data, pos, 1, minor);
}
__name(decodeBytesCompact, "decodeBytesCompact");
function decodeBytes8(data, pos, _minor, options) {
  return toToken(data, pos, 2, readUint8(data, pos + 1, options));
}
__name(decodeBytes8, "decodeBytes8");
function decodeBytes16(data, pos, _minor, options) {
  return toToken(data, pos, 3, readUint16(data, pos + 1, options));
}
__name(decodeBytes16, "decodeBytes16");
function decodeBytes32(data, pos, _minor, options) {
  return toToken(data, pos, 5, readUint32(data, pos + 1, options));
}
__name(decodeBytes32, "decodeBytes32");
function decodeBytes64(data, pos, _minor, options) {
  const l = readUint64(data, pos + 1, options);
  if (typeof l === "bigint") {
    throw new Error(`${decodeErrPrefix} 64-bit integer bytes lengths not supported`);
  }
  return toToken(data, pos, 9, l);
}
__name(decodeBytes64, "decodeBytes64");
function tokenBytes(token) {
  if (token.encodedBytes === void 0) {
    token.encodedBytes = Type.equals(token.type, Type.string) ? fromString(token.value) : token.value;
  }
  return token.encodedBytes;
}
__name(tokenBytes, "tokenBytes");
function encodeBytes(writer, token) {
  const bytes2 = tokenBytes(token);
  encodeUintValue(writer, token.type.majorEncoded, bytes2.length);
  writer.push(bytes2);
}
__name(encodeBytes, "encodeBytes");
encodeBytes.encodedSize = /* @__PURE__ */ __name(function encodedSize4(token) {
  const bytes2 = tokenBytes(token);
  return encodeUintValue.encodedSize(bytes2.length) + bytes2.length;
}, "encodedSize");
encodeBytes.compareTokens = /* @__PURE__ */ __name(function compareTokens3(tok1, tok2) {
  return compareBytes(tokenBytes(tok1), tokenBytes(tok2));
}, "compareTokens");
function compareBytes(b1, b2) {
  return b1.length < b2.length ? -1 : b1.length > b2.length ? 1 : compare(b1, b2);
}
__name(compareBytes, "compareBytes");

// node_modules/cborg/lib/3string.js
var textDecoder = new TextDecoder();
var ASCII_THRESHOLD = 32;
function toStr2(bytes2, start, end) {
  const len = end - start;
  if (len < ASCII_THRESHOLD) {
    let str = "";
    for (let i = start; i < end; i++) {
      const c = bytes2[i];
      if (c & 128) {
        return textDecoder.decode(bytes2.subarray(start, end));
      }
      str += String.fromCharCode(c);
    }
    return str;
  }
  return textDecoder.decode(bytes2.subarray(start, end));
}
__name(toStr2, "toStr");
function toToken2(data, pos, prefix2, length2, options) {
  const totLength = prefix2 + length2;
  assertEnoughData(data, pos, totLength);
  const tok = new Token(Type.string, toStr2(data, pos + prefix2, pos + totLength), totLength);
  if (options.retainStringBytes === true) {
    tok.byteValue = data.slice(pos + prefix2, pos + totLength);
  }
  return tok;
}
__name(toToken2, "toToken");
function decodeStringCompact(data, pos, minor, options) {
  return toToken2(data, pos, 1, minor, options);
}
__name(decodeStringCompact, "decodeStringCompact");
function decodeString8(data, pos, _minor, options) {
  return toToken2(data, pos, 2, readUint8(data, pos + 1, options), options);
}
__name(decodeString8, "decodeString8");
function decodeString16(data, pos, _minor, options) {
  return toToken2(data, pos, 3, readUint16(data, pos + 1, options), options);
}
__name(decodeString16, "decodeString16");
function decodeString32(data, pos, _minor, options) {
  return toToken2(data, pos, 5, readUint32(data, pos + 1, options), options);
}
__name(decodeString32, "decodeString32");
function decodeString64(data, pos, _minor, options) {
  const l = readUint64(data, pos + 1, options);
  if (typeof l === "bigint") {
    throw new Error(`${decodeErrPrefix} 64-bit integer string lengths not supported`);
  }
  return toToken2(data, pos, 9, l, options);
}
__name(decodeString64, "decodeString64");
var encodeString = encodeBytes;

// node_modules/cborg/lib/4array.js
function toToken3(_data, _pos, prefix2, length2) {
  return new Token(Type.array, length2, prefix2);
}
__name(toToken3, "toToken");
function decodeArrayCompact(data, pos, minor, _options) {
  return toToken3(data, pos, 1, minor);
}
__name(decodeArrayCompact, "decodeArrayCompact");
function decodeArray8(data, pos, _minor, options) {
  return toToken3(data, pos, 2, readUint8(data, pos + 1, options));
}
__name(decodeArray8, "decodeArray8");
function decodeArray16(data, pos, _minor, options) {
  return toToken3(data, pos, 3, readUint16(data, pos + 1, options));
}
__name(decodeArray16, "decodeArray16");
function decodeArray32(data, pos, _minor, options) {
  return toToken3(data, pos, 5, readUint32(data, pos + 1, options));
}
__name(decodeArray32, "decodeArray32");
function decodeArray64(data, pos, _minor, options) {
  const l = readUint64(data, pos + 1, options);
  if (typeof l === "bigint") {
    throw new Error(`${decodeErrPrefix} 64-bit integer array lengths not supported`);
  }
  return toToken3(data, pos, 9, l);
}
__name(decodeArray64, "decodeArray64");
function decodeArrayIndefinite(data, pos, _minor, options) {
  if (options.allowIndefinite === false) {
    throw new Error(`${decodeErrPrefix} indefinite length items not allowed`);
  }
  return toToken3(data, pos, 1, Infinity);
}
__name(decodeArrayIndefinite, "decodeArrayIndefinite");
function encodeArray(writer, token) {
  encodeUintValue(writer, Type.array.majorEncoded, token.value);
}
__name(encodeArray, "encodeArray");
encodeArray.compareTokens = encodeUint.compareTokens;
encodeArray.encodedSize = /* @__PURE__ */ __name(function encodedSize5(token) {
  return encodeUintValue.encodedSize(token.value);
}, "encodedSize");

// node_modules/cborg/lib/5map.js
function toToken4(_data, _pos, prefix2, length2) {
  return new Token(Type.map, length2, prefix2);
}
__name(toToken4, "toToken");
function decodeMapCompact(data, pos, minor, _options) {
  return toToken4(data, pos, 1, minor);
}
__name(decodeMapCompact, "decodeMapCompact");
function decodeMap8(data, pos, _minor, options) {
  return toToken4(data, pos, 2, readUint8(data, pos + 1, options));
}
__name(decodeMap8, "decodeMap8");
function decodeMap16(data, pos, _minor, options) {
  return toToken4(data, pos, 3, readUint16(data, pos + 1, options));
}
__name(decodeMap16, "decodeMap16");
function decodeMap32(data, pos, _minor, options) {
  return toToken4(data, pos, 5, readUint32(data, pos + 1, options));
}
__name(decodeMap32, "decodeMap32");
function decodeMap64(data, pos, _minor, options) {
  const l = readUint64(data, pos + 1, options);
  if (typeof l === "bigint") {
    throw new Error(`${decodeErrPrefix} 64-bit integer map lengths not supported`);
  }
  return toToken4(data, pos, 9, l);
}
__name(decodeMap64, "decodeMap64");
function decodeMapIndefinite(data, pos, _minor, options) {
  if (options.allowIndefinite === false) {
    throw new Error(`${decodeErrPrefix} indefinite length items not allowed`);
  }
  return toToken4(data, pos, 1, Infinity);
}
__name(decodeMapIndefinite, "decodeMapIndefinite");
function encodeMap(writer, token) {
  encodeUintValue(writer, Type.map.majorEncoded, token.value);
}
__name(encodeMap, "encodeMap");
encodeMap.compareTokens = encodeUint.compareTokens;
encodeMap.encodedSize = /* @__PURE__ */ __name(function encodedSize6(token) {
  return encodeUintValue.encodedSize(token.value);
}, "encodedSize");

// node_modules/cborg/lib/6tag.js
function decodeTagCompact(_data, _pos, minor, _options) {
  return new Token(Type.tag, minor, 1);
}
__name(decodeTagCompact, "decodeTagCompact");
function decodeTag8(data, pos, _minor, options) {
  return new Token(Type.tag, readUint8(data, pos + 1, options), 2);
}
__name(decodeTag8, "decodeTag8");
function decodeTag16(data, pos, _minor, options) {
  return new Token(Type.tag, readUint16(data, pos + 1, options), 3);
}
__name(decodeTag16, "decodeTag16");
function decodeTag32(data, pos, _minor, options) {
  return new Token(Type.tag, readUint32(data, pos + 1, options), 5);
}
__name(decodeTag32, "decodeTag32");
function decodeTag64(data, pos, _minor, options) {
  return new Token(Type.tag, readUint64(data, pos + 1, options), 9);
}
__name(decodeTag64, "decodeTag64");
function encodeTag(writer, token) {
  encodeUintValue(writer, Type.tag.majorEncoded, token.value);
}
__name(encodeTag, "encodeTag");
encodeTag.compareTokens = encodeUint.compareTokens;
encodeTag.encodedSize = /* @__PURE__ */ __name(function encodedSize7(token) {
  return encodeUintValue.encodedSize(token.value);
}, "encodedSize");

// node_modules/cborg/lib/7float.js
var MINOR_FALSE = 20;
var MINOR_TRUE = 21;
var MINOR_NULL = 22;
var MINOR_UNDEFINED = 23;
function decodeUndefined(_data, _pos, _minor, options) {
  if (options.allowUndefined === false) {
    throw new Error(`${decodeErrPrefix} undefined values are not supported`);
  } else if (options.coerceUndefinedToNull === true) {
    return new Token(Type.null, null, 1);
  }
  return new Token(Type.undefined, void 0, 1);
}
__name(decodeUndefined, "decodeUndefined");
function decodeBreak(_data, _pos, _minor, options) {
  if (options.allowIndefinite === false) {
    throw new Error(`${decodeErrPrefix} indefinite length items not allowed`);
  }
  return new Token(Type.break, void 0, 1);
}
__name(decodeBreak, "decodeBreak");
function createToken(value, bytes2, options) {
  if (options) {
    if (options.allowNaN === false && Number.isNaN(value)) {
      throw new Error(`${decodeErrPrefix} NaN values are not supported`);
    }
    if (options.allowInfinity === false && (value === Infinity || value === -Infinity)) {
      throw new Error(`${decodeErrPrefix} Infinity values are not supported`);
    }
  }
  return new Token(Type.float, value, bytes2);
}
__name(createToken, "createToken");
function decodeFloat16(data, pos, _minor, options) {
  return createToken(readFloat16(data, pos + 1), 3, options);
}
__name(decodeFloat16, "decodeFloat16");
function decodeFloat32(data, pos, _minor, options) {
  return createToken(readFloat32(data, pos + 1), 5, options);
}
__name(decodeFloat32, "decodeFloat32");
function decodeFloat64(data, pos, _minor, options) {
  return createToken(readFloat64(data, pos + 1), 9, options);
}
__name(decodeFloat64, "decodeFloat64");
function encodeFloat(writer, token, options) {
  const float = token.value;
  if (float === false) {
    writer.push([Type.float.majorEncoded | MINOR_FALSE]);
  } else if (float === true) {
    writer.push([Type.float.majorEncoded | MINOR_TRUE]);
  } else if (float === null) {
    writer.push([Type.float.majorEncoded | MINOR_NULL]);
  } else if (float === void 0) {
    writer.push([Type.float.majorEncoded | MINOR_UNDEFINED]);
  } else {
    let decoded;
    let success = false;
    if (!options || options.float64 !== true) {
      encodeFloat16(float);
      decoded = readFloat16(ui8a, 1);
      if (float === decoded || Number.isNaN(float)) {
        ui8a[0] = 249;
        writer.push(ui8a.slice(0, 3));
        success = true;
      } else {
        encodeFloat32(float);
        decoded = readFloat32(ui8a, 1);
        if (float === decoded) {
          ui8a[0] = 250;
          writer.push(ui8a.slice(0, 5));
          success = true;
        }
      }
    }
    if (!success) {
      encodeFloat64(float);
      decoded = readFloat64(ui8a, 1);
      ui8a[0] = 251;
      writer.push(ui8a.slice(0, 9));
    }
  }
}
__name(encodeFloat, "encodeFloat");
encodeFloat.encodedSize = /* @__PURE__ */ __name(function encodedSize8(token, options) {
  const float = token.value;
  if (float === false || float === true || float === null || float === void 0) {
    return 1;
  }
  if (!options || options.float64 !== true) {
    encodeFloat16(float);
    let decoded = readFloat16(ui8a, 1);
    if (float === decoded || Number.isNaN(float)) {
      return 3;
    }
    encodeFloat32(float);
    decoded = readFloat32(ui8a, 1);
    if (float === decoded) {
      return 5;
    }
  }
  return 9;
}, "encodedSize");
var buffer = new ArrayBuffer(9);
var dataView = new DataView(buffer, 1);
var ui8a = new Uint8Array(buffer, 0);
function encodeFloat16(inp) {
  if (inp === Infinity) {
    dataView.setUint16(0, 31744, false);
  } else if (inp === -Infinity) {
    dataView.setUint16(0, 64512, false);
  } else if (Number.isNaN(inp)) {
    dataView.setUint16(0, 32256, false);
  } else {
    dataView.setFloat32(0, inp);
    const valu32 = dataView.getUint32(0);
    const exponent = (valu32 & 2139095040) >> 23;
    const mantissa = valu32 & 8388607;
    if (exponent === 255) {
      dataView.setUint16(0, 31744, false);
    } else if (exponent === 0) {
      dataView.setUint16(0, (valu32 & 2147483648) >> 16 | mantissa >> 13, false);
    } else {
      const logicalExponent = exponent - 127;
      if (logicalExponent < -24) {
        dataView.setUint16(0, 0);
      } else if (logicalExponent < -14) {
        dataView.setUint16(0, (valu32 & 2147483648) >> 16 | /* sign bit */
        1 << 24 + logicalExponent, false);
      } else {
        dataView.setUint16(0, (valu32 & 2147483648) >> 16 | logicalExponent + 15 << 10 | mantissa >> 13, false);
      }
    }
  }
}
__name(encodeFloat16, "encodeFloat16");
function readFloat16(ui8a2, pos) {
  if (ui8a2.length - pos < 2) {
    throw new Error(`${decodeErrPrefix} not enough data for float16`);
  }
  const half = (ui8a2[pos] << 8) + ui8a2[pos + 1];
  if (half === 31744) {
    return Infinity;
  }
  if (half === 64512) {
    return -Infinity;
  }
  if (half === 32256) {
    return NaN;
  }
  const exp = half >> 10 & 31;
  const mant = half & 1023;
  let val;
  if (exp === 0) {
    val = mant * 2 ** -24;
  } else if (exp !== 31) {
    val = (mant + 1024) * 2 ** (exp - 25);
  } else {
    val = mant === 0 ? Infinity : NaN;
  }
  return half & 32768 ? -val : val;
}
__name(readFloat16, "readFloat16");
function encodeFloat32(inp) {
  dataView.setFloat32(0, inp, false);
}
__name(encodeFloat32, "encodeFloat32");
function readFloat32(ui8a2, pos) {
  if (ui8a2.length - pos < 4) {
    throw new Error(`${decodeErrPrefix} not enough data for float32`);
  }
  const offset2 = (ui8a2.byteOffset || 0) + pos;
  return new DataView(ui8a2.buffer, offset2, 4).getFloat32(0, false);
}
__name(readFloat32, "readFloat32");
function encodeFloat64(inp) {
  dataView.setFloat64(0, inp, false);
}
__name(encodeFloat64, "encodeFloat64");
function readFloat64(ui8a2, pos) {
  if (ui8a2.length - pos < 8) {
    throw new Error(`${decodeErrPrefix} not enough data for float64`);
  }
  const offset2 = (ui8a2.byteOffset || 0) + pos;
  return new DataView(ui8a2.buffer, offset2, 8).getFloat64(0, false);
}
__name(readFloat64, "readFloat64");
encodeFloat.compareTokens = encodeUint.compareTokens;

// node_modules/cborg/lib/jump.js
function invalidMinor(data, pos, minor) {
  throw new Error(`${decodeErrPrefix} encountered invalid minor (${minor}) for major ${data[pos] >>> 5}`);
}
__name(invalidMinor, "invalidMinor");
function errorer(msg) {
  return () => {
    throw new Error(`${decodeErrPrefix} ${msg}`);
  };
}
__name(errorer, "errorer");
var jump = [];
for (let i = 0; i <= 23; i++) {
  jump[i] = invalidMinor;
}
jump[24] = decodeUint8;
jump[25] = decodeUint16;
jump[26] = decodeUint32;
jump[27] = decodeUint64;
jump[28] = invalidMinor;
jump[29] = invalidMinor;
jump[30] = invalidMinor;
jump[31] = invalidMinor;
for (let i = 32; i <= 55; i++) {
  jump[i] = invalidMinor;
}
jump[56] = decodeNegint8;
jump[57] = decodeNegint16;
jump[58] = decodeNegint32;
jump[59] = decodeNegint64;
jump[60] = invalidMinor;
jump[61] = invalidMinor;
jump[62] = invalidMinor;
jump[63] = invalidMinor;
for (let i = 64; i <= 87; i++) {
  jump[i] = decodeBytesCompact;
}
jump[88] = decodeBytes8;
jump[89] = decodeBytes16;
jump[90] = decodeBytes32;
jump[91] = decodeBytes64;
jump[92] = invalidMinor;
jump[93] = invalidMinor;
jump[94] = invalidMinor;
jump[95] = errorer("indefinite length bytes/strings are not supported");
for (let i = 96; i <= 119; i++) {
  jump[i] = decodeStringCompact;
}
jump[120] = decodeString8;
jump[121] = decodeString16;
jump[122] = decodeString32;
jump[123] = decodeString64;
jump[124] = invalidMinor;
jump[125] = invalidMinor;
jump[126] = invalidMinor;
jump[127] = errorer("indefinite length bytes/strings are not supported");
for (let i = 128; i <= 151; i++) {
  jump[i] = decodeArrayCompact;
}
jump[152] = decodeArray8;
jump[153] = decodeArray16;
jump[154] = decodeArray32;
jump[155] = decodeArray64;
jump[156] = invalidMinor;
jump[157] = invalidMinor;
jump[158] = invalidMinor;
jump[159] = decodeArrayIndefinite;
for (let i = 160; i <= 183; i++) {
  jump[i] = decodeMapCompact;
}
jump[184] = decodeMap8;
jump[185] = decodeMap16;
jump[186] = decodeMap32;
jump[187] = decodeMap64;
jump[188] = invalidMinor;
jump[189] = invalidMinor;
jump[190] = invalidMinor;
jump[191] = decodeMapIndefinite;
for (let i = 192; i <= 215; i++) {
  jump[i] = decodeTagCompact;
}
jump[216] = decodeTag8;
jump[217] = decodeTag16;
jump[218] = decodeTag32;
jump[219] = decodeTag64;
jump[220] = invalidMinor;
jump[221] = invalidMinor;
jump[222] = invalidMinor;
jump[223] = invalidMinor;
for (let i = 224; i <= 243; i++) {
  jump[i] = errorer("simple values are not supported");
}
jump[244] = invalidMinor;
jump[245] = invalidMinor;
jump[246] = invalidMinor;
jump[247] = decodeUndefined;
jump[248] = errorer("simple values are not supported");
jump[249] = decodeFloat16;
jump[250] = decodeFloat32;
jump[251] = decodeFloat64;
jump[252] = invalidMinor;
jump[253] = invalidMinor;
jump[254] = invalidMinor;
jump[255] = decodeBreak;
var quick = [];
for (let i = 0; i < 24; i++) {
  quick[i] = new Token(Type.uint, i, 1);
}
for (let i = -1; i >= -24; i--) {
  quick[31 - i] = new Token(Type.negint, i, 1);
}
quick[64] = new Token(Type.bytes, new Uint8Array(0), 1);
quick[96] = new Token(Type.string, "", 1);
quick[128] = new Token(Type.array, 0, 1);
quick[160] = new Token(Type.map, 0, 1);
quick[244] = new Token(Type.false, false, 1);
quick[245] = new Token(Type.true, true, 1);
quick[246] = new Token(Type.null, null, 1);
function quickEncodeToken(token) {
  switch (token.type) {
    case Type.false:
      return fromArray([244]);
    case Type.true:
      return fromArray([245]);
    case Type.null:
      return fromArray([246]);
    case Type.bytes:
      if (!token.value.length) {
        return fromArray([64]);
      }
      return;
    case Type.string:
      if (token.value === "") {
        return fromArray([96]);
      }
      return;
    case Type.array:
      if (token.value === 0) {
        return fromArray([128]);
      }
      return;
    case Type.map:
      if (token.value === 0) {
        return fromArray([160]);
      }
      return;
    case Type.uint:
      if (token.value < 24) {
        return fromArray([Number(token.value)]);
      }
      return;
    case Type.negint:
      if (token.value >= -24) {
        return fromArray([31 - Number(token.value)]);
      }
  }
}
__name(quickEncodeToken, "quickEncodeToken");

// node_modules/cborg/lib/encode.js
var rfc8949EncodeOptions = Object.freeze({
  mapSorter: rfc8949MapSorter,
  quickEncodeToken
});
function makeCborEncoders() {
  const encoders = [];
  encoders[Type.uint.major] = encodeUint;
  encoders[Type.negint.major] = encodeNegint;
  encoders[Type.bytes.major] = encodeBytes;
  encoders[Type.string.major] = encodeString;
  encoders[Type.array.major] = encodeArray;
  encoders[Type.map.major] = encodeMap;
  encoders[Type.tag.major] = encodeTag;
  encoders[Type.float.major] = encodeFloat;
  return encoders;
}
__name(makeCborEncoders, "makeCborEncoders");
var cborEncoders = makeCborEncoders();
var defaultWriter = new Bl();
var Ref = class {
  /**
   * @param {object|any[]} obj
   * @param {Reference|undefined} parent
   */
  constructor(obj, parent) {
    this.obj = obj;
    this.parent = parent;
  }
  /**
   * @param {object|any[]} obj
   * @returns {boolean}
   */
  includes(obj) {
    let p = this;
    do {
      if (p.obj === obj) {
        return true;
      }
    } while (p = p.parent);
    return false;
  }
  /**
   * @param {Reference|undefined} stack
   * @param {object|any[]} obj
   * @returns {Reference}
   */
  static createCheck(stack, obj) {
    if (stack && stack.includes(obj)) {
      throw new Error(`${encodeErrPrefix} object contains circular references`);
    }
    return new Ref(obj, stack);
  }
};
__name(Ref, "Ref");
var simpleTokens = {
  null: new Token(Type.null, null),
  undefined: new Token(Type.undefined, void 0),
  true: new Token(Type.true, true),
  false: new Token(Type.false, false),
  emptyArray: new Token(Type.array, 0),
  emptyMap: new Token(Type.map, 0)
};
var typeEncoders = {
  /**
   * @param {any} obj
   * @param {string} _typ
   * @param {EncodeOptions} _options
   * @param {Reference} [_refStack]
   * @returns {TokenOrNestedTokens}
   */
  number(obj, _typ, _options, _refStack) {
    if (!Number.isInteger(obj) || !Number.isSafeInteger(obj)) {
      return new Token(Type.float, obj);
    } else if (obj >= 0) {
      return new Token(Type.uint, obj);
    } else {
      return new Token(Type.negint, obj);
    }
  },
  /**
   * @param {any} obj
   * @param {string} _typ
   * @param {EncodeOptions} _options
   * @param {Reference} [_refStack]
   * @returns {TokenOrNestedTokens}
   */
  bigint(obj, _typ, _options, _refStack) {
    if (obj >= BigInt(0)) {
      return new Token(Type.uint, obj);
    } else {
      return new Token(Type.negint, obj);
    }
  },
  /**
   * @param {any} obj
   * @param {string} _typ
   * @param {EncodeOptions} _options
   * @param {Reference} [_refStack]
   * @returns {TokenOrNestedTokens}
   */
  Uint8Array(obj, _typ, _options, _refStack) {
    return new Token(Type.bytes, obj);
  },
  /**
   * @param {any} obj
   * @param {string} _typ
   * @param {EncodeOptions} _options
   * @param {Reference} [_refStack]
   * @returns {TokenOrNestedTokens}
   */
  string(obj, _typ, _options, _refStack) {
    return new Token(Type.string, obj);
  },
  /**
   * @param {any} obj
   * @param {string} _typ
   * @param {EncodeOptions} _options
   * @param {Reference} [_refStack]
   * @returns {TokenOrNestedTokens}
   */
  boolean(obj, _typ, _options, _refStack) {
    return obj ? simpleTokens.true : simpleTokens.false;
  },
  /**
   * @param {any} _obj
   * @param {string} _typ
   * @param {EncodeOptions} _options
   * @param {Reference} [_refStack]
   * @returns {TokenOrNestedTokens}
   */
  null(_obj, _typ, _options, _refStack) {
    return simpleTokens.null;
  },
  /**
   * @param {any} _obj
   * @param {string} _typ
   * @param {EncodeOptions} _options
   * @param {Reference} [_refStack]
   * @returns {TokenOrNestedTokens}
   */
  undefined(_obj, _typ, _options, _refStack) {
    return simpleTokens.undefined;
  },
  /**
   * @param {any} obj
   * @param {string} _typ
   * @param {EncodeOptions} _options
   * @param {Reference} [_refStack]
   * @returns {TokenOrNestedTokens}
   */
  ArrayBuffer(obj, _typ, _options, _refStack) {
    return new Token(Type.bytes, new Uint8Array(obj));
  },
  /**
   * @param {any} obj
   * @param {string} _typ
   * @param {EncodeOptions} _options
   * @param {Reference} [_refStack]
   * @returns {TokenOrNestedTokens}
   */
  DataView(obj, _typ, _options, _refStack) {
    return new Token(Type.bytes, new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength));
  },
  /**
   * @param {any} obj
   * @param {string} _typ
   * @param {EncodeOptions} options
   * @param {Reference} [refStack]
   * @returns {TokenOrNestedTokens}
   */
  Array(obj, _typ, options, refStack) {
    if (!obj.length) {
      if (options.addBreakTokens === true) {
        return [simpleTokens.emptyArray, new Token(Type.break)];
      }
      return simpleTokens.emptyArray;
    }
    refStack = Ref.createCheck(refStack, obj);
    const entries = [];
    let i = 0;
    for (const e of obj) {
      entries[i++] = objectToTokens(e, options, refStack);
    }
    if (options.addBreakTokens) {
      return [new Token(Type.array, obj.length), entries, new Token(Type.break)];
    }
    return [new Token(Type.array, obj.length), entries];
  },
  /**
   * @param {any} obj
   * @param {string} typ
   * @param {EncodeOptions} options
   * @param {Reference} [refStack]
   * @returns {TokenOrNestedTokens}
   */
  Object(obj, typ, options, refStack) {
    const isMap = typ !== "Object";
    const keys = isMap ? obj.keys() : Object.keys(obj);
    const maxLength = isMap ? obj.size : keys.length;
    let entries;
    if (maxLength) {
      entries = new Array(maxLength);
      refStack = Ref.createCheck(refStack, obj);
      const skipUndefined = !isMap && options.ignoreUndefinedProperties;
      let i = 0;
      for (const key of keys) {
        const value = isMap ? obj.get(key) : obj[key];
        if (skipUndefined && value === void 0) {
          continue;
        }
        entries[i++] = [
          objectToTokens(key, options, refStack),
          objectToTokens(value, options, refStack)
        ];
      }
      if (i < maxLength) {
        entries.length = i;
      }
    }
    if (!entries?.length) {
      if (options.addBreakTokens === true) {
        return [simpleTokens.emptyMap, new Token(Type.break)];
      }
      return simpleTokens.emptyMap;
    }
    sortMapEntries(entries, options);
    if (options.addBreakTokens) {
      return [new Token(Type.map, entries.length), entries, new Token(Type.break)];
    }
    return [new Token(Type.map, entries.length), entries];
  },
  /**
   * Encode a `Tagged` wrapper as a CBOR tag header followed by the encoded
   * form of the wrapped value. The value is recursively tokenised through
   * `objectToTokens()` so any registered `typeEncoders` apply to it.
   *
   * @param {any} obj
   * @param {string} _typ
   * @param {EncodeOptions} options
   * @param {Reference} [refStack]
   * @returns {TokenOrNestedTokens}
   */
  Tagged(obj, _typ, options, refStack) {
    return [
      new Token(Type.tag, obj.tag),
      objectToTokens(obj.value, options, refStack)
    ];
  }
};
typeEncoders.Map = typeEncoders.Object;
typeEncoders.Buffer = typeEncoders.Uint8Array;
for (const typ of "Uint8Clamped Uint16 Uint32 Int8 Int16 Int32 BigUint64 BigInt64 Float32 Float64".split(" ")) {
  typeEncoders[`${typ}Array`] = typeEncoders.DataView;
}
function objectToTokens(obj, options = {}, refStack) {
  const typ = is(obj);
  const customTypeEncoder = options && options.typeEncoders && /** @type {OptionalTypeEncoder} */
  options.typeEncoders[typ] || typeEncoders[typ];
  if (typeof customTypeEncoder === "function") {
    const tokens = customTypeEncoder(obj, typ, options, refStack);
    if (tokens != null) {
      return tokens;
    }
  }
  const typeEncoder = typeEncoders[typ];
  if (!typeEncoder) {
    throw new Error(`${encodeErrPrefix} unsupported type: ${typ}`);
  }
  return typeEncoder(obj, typ, options, refStack);
}
__name(objectToTokens, "objectToTokens");
function sortMapEntries(entries, options) {
  if (options.mapSorter) {
    entries.sort(options.mapSorter);
  }
}
__name(sortMapEntries, "sortMapEntries");
function rfc8949MapSorter(e1, e2) {
  if (e1[0] instanceof Token && e2[0] instanceof Token) {
    const t1 = (
      /** @type {TokenEx} */
      e1[0]
    );
    const t2 = (
      /** @type {TokenEx} */
      e2[0]
    );
    if (!t1._keyBytes) {
      t1._keyBytes = encodeRfc8949(t1.value);
    }
    if (!t2._keyBytes) {
      t2._keyBytes = encodeRfc8949(t2.value);
    }
    return compare(t1._keyBytes, t2._keyBytes);
  }
  throw new Error("rfc8949MapSorter: complex key types are not supported yet");
}
__name(rfc8949MapSorter, "rfc8949MapSorter");
function encodeRfc8949(data) {
  return encodeCustom(data, cborEncoders, rfc8949EncodeOptions);
}
__name(encodeRfc8949, "encodeRfc8949");
function tokensToEncoded(writer, tokens, encoders, options) {
  if (Array.isArray(tokens)) {
    for (const token of tokens) {
      tokensToEncoded(writer, token, encoders, options);
    }
  } else {
    encoders[tokens.type.major](writer, tokens, options);
  }
}
__name(tokensToEncoded, "tokensToEncoded");
var MAJOR_UINT = Type.uint.majorEncoded;
var MAJOR_NEGINT = Type.negint.majorEncoded;
var MAJOR_BYTES = Type.bytes.majorEncoded;
var MAJOR_STRING = Type.string.majorEncoded;
var MAJOR_ARRAY = Type.array.majorEncoded;
var SIMPLE_FALSE = Type.float.majorEncoded | MINOR_FALSE;
var SIMPLE_TRUE = Type.float.majorEncoded | MINOR_TRUE;
var SIMPLE_NULL = Type.float.majorEncoded | MINOR_NULL;
var SIMPLE_UNDEFINED = Type.float.majorEncoded | MINOR_UNDEFINED;
var neg1b2 = BigInt(-1);
var pos1b2 = BigInt(1);
function encodeCustom(data, encoders, options, destination) {
  const hasDest = destination instanceof Uint8Array;
  let writeTo = hasDest ? new U8Bl(destination) : defaultWriter;
  const tokens = objectToTokens(data, options);
  if (!Array.isArray(tokens) && options.quickEncodeToken) {
    const quickBytes = options.quickEncodeToken(tokens);
    if (quickBytes) {
      if (hasDest) {
        writeTo.push(quickBytes);
        return writeTo.toBytes();
      }
      return quickBytes;
    }
    const encoder3 = encoders[tokens.type.major];
    if (encoder3.encodedSize) {
      const size3 = encoder3.encodedSize(tokens, options);
      if (!hasDest) {
        writeTo = new Bl(size3);
      }
      encoder3(writeTo, tokens, options);
      if (writeTo.chunks.length !== 1) {
        throw new Error(`Unexpected error: pre-calculated length for ${tokens} was wrong`);
      }
      return hasDest ? writeTo.toBytes() : asU8A(writeTo.chunks[0]);
    }
  }
  writeTo.reset();
  tokensToEncoded(writeTo, tokens, encoders, options);
  return writeTo.toBytes(true);
}
__name(encodeCustom, "encodeCustom");

// node_modules/cborg/lib/decode.js
var DONE = Symbol.for("DONE");
var BREAK = Symbol.for("BREAK");

// node_modules/cborg/lib/tagged.js
var Tagged = class {
  /**
   * @param {number} tag - CBOR tag number, a non-negative integer
   * @param {any} value - The value to be tagged; encoded recursively
   */
  constructor(tag, value) {
    if (typeof tag !== "number" || !Number.isInteger(tag) || tag < 0) {
      throw new TypeError("Tagged: tag must be a non-negative integer");
    }
    this.tag = tag;
    this.value = value;
  }
  /**
   * Build a tag decoder for use in `decode()`'s `tags` option that returns the
   * decoded content wrapped in a `Tagged` instance, preserving the tag number
   * for the caller to inspect.
   *
   * @param {number} tag - The CBOR tag number this decoder will be registered for
   * @returns {TaggedTagDecoder}
   *
   * @example
   * import { decode, Tagged } from 'cborg'
   * const value = decode(bytes, { tags: { 16: Tagged.decoder(16) } })
   * // value instanceof Tagged; value.tag === 16
   */
  static decoder(tag) {
    return (decode7) => new Tagged(tag, decode7());
  }
  /**
   * Build a `tags` option for `decode()` that wraps each listed tag number in
   * a `Tagged` instance, preserving those tags through decode without
   * registering a dedicated decoder per tag.
   *
   * @param {...number} tagNumbers - One or more CBOR tag numbers to preserve
   * @returns {{[tagNumber: number]: TaggedTagDecoder}}
   *
   * @example
   * import { decode, Tagged } from 'cborg'
   * const value = decode(bytes, { tags: Tagged.preserve(16, 96) })
   */
  static preserve(...tagNumbers) {
    const tags = {};
    for (const tag of tagNumbers) {
      tags[tag] = Tagged.decoder(tag);
    }
    return tags;
  }
};
__name(Tagged, "Tagged");
Object.defineProperty(Tagged.prototype, Symbol.toStringTag, {
  value: "Tagged"
});

// node_modules/multiformats/dist/src/vendor/base-x.js
function base(ALPHABET, name5) {
  if (ALPHABET.length >= 255) {
    throw new TypeError("Alphabet too long");
  }
  var BASE_MAP = new Uint8Array(256);
  for (var j = 0; j < BASE_MAP.length; j++) {
    BASE_MAP[j] = 255;
  }
  for (var i = 0; i < ALPHABET.length; i++) {
    var x = ALPHABET.charAt(i);
    var xc = x.charCodeAt(0);
    if (BASE_MAP[xc] !== 255) {
      throw new TypeError(x + " is ambiguous");
    }
    BASE_MAP[xc] = i;
  }
  var BASE = ALPHABET.length;
  var LEADER = ALPHABET.charAt(0);
  var FACTOR = Math.log(BASE) / Math.log(256);
  var iFACTOR = Math.log(256) / Math.log(BASE);
  function encode5(source) {
    if (source instanceof Uint8Array)
      ;
    else if (ArrayBuffer.isView(source)) {
      source = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    } else if (Array.isArray(source)) {
      source = Uint8Array.from(source);
    }
    if (!(source instanceof Uint8Array)) {
      throw new TypeError("Expected Uint8Array");
    }
    if (source.length === 0) {
      return "";
    }
    var zeroes = 0;
    var length2 = 0;
    var pbegin = 0;
    var pend = source.length;
    while (pbegin !== pend && source[pbegin] === 0) {
      pbegin++;
      zeroes++;
    }
    var size3 = (pend - pbegin) * iFACTOR + 1 >>> 0;
    var b58 = new Uint8Array(size3);
    while (pbegin !== pend) {
      var carry = source[pbegin];
      var i2 = 0;
      for (var it1 = size3 - 1; (carry !== 0 || i2 < length2) && it1 !== -1; it1--, i2++) {
        carry += 256 * b58[it1] >>> 0;
        b58[it1] = carry % BASE >>> 0;
        carry = carry / BASE >>> 0;
      }
      if (carry !== 0) {
        throw new Error("Non-zero carry");
      }
      length2 = i2;
      pbegin++;
    }
    var it2 = size3 - length2;
    while (it2 !== size3 && b58[it2] === 0) {
      it2++;
    }
    var str = LEADER.repeat(zeroes);
    for (; it2 < size3; ++it2) {
      str += ALPHABET.charAt(b58[it2]);
    }
    return str;
  }
  __name(encode5, "encode");
  function decodeUnsafe(source) {
    if (typeof source !== "string") {
      throw new TypeError("Expected String");
    }
    if (source.length === 0) {
      return new Uint8Array();
    }
    var psz = 0;
    if (source[psz] === " ") {
      return;
    }
    var zeroes = 0;
    var length2 = 0;
    while (source[psz] === LEADER) {
      zeroes++;
      psz++;
    }
    var size3 = (source.length - psz) * FACTOR + 1 >>> 0;
    var b256 = new Uint8Array(size3);
    while (source[psz]) {
      var carry = BASE_MAP[source.charCodeAt(psz)];
      if (carry === 255) {
        return;
      }
      var i2 = 0;
      for (var it3 = size3 - 1; (carry !== 0 || i2 < length2) && it3 !== -1; it3--, i2++) {
        carry += BASE * b256[it3] >>> 0;
        b256[it3] = carry % 256 >>> 0;
        carry = carry / 256 >>> 0;
      }
      if (carry !== 0) {
        throw new Error("Non-zero carry");
      }
      length2 = i2;
      psz++;
    }
    if (source[psz] === " ") {
      return;
    }
    var it4 = size3 - length2;
    while (it4 !== size3 && b256[it4] === 0) {
      it4++;
    }
    var vch = new Uint8Array(zeroes + (size3 - it4));
    var j2 = zeroes;
    while (it4 !== size3) {
      vch[j2++] = b256[it4++];
    }
    return vch;
  }
  __name(decodeUnsafe, "decodeUnsafe");
  function decode7(string) {
    var buffer2 = decodeUnsafe(string);
    if (buffer2) {
      return buffer2;
    }
    throw new Error(`Non-${name5} character`);
  }
  __name(decode7, "decode");
  return {
    encode: encode5,
    decodeUnsafe,
    decode: decode7
  };
}
__name(base, "base");
var src = base;
var _brrp__multiformats_scope_baseX = src;
var base_x_default = _brrp__multiformats_scope_baseX;

// node_modules/multiformats/dist/src/bases/base.js
var Encoder = class {
  name;
  prefix;
  baseEncode;
  constructor(name5, prefix2, baseEncode) {
    this.name = name5;
    this.prefix = prefix2;
    this.baseEncode = baseEncode;
  }
  encode(bytes2) {
    if (bytes2 instanceof Uint8Array) {
      return `${this.prefix}${this.baseEncode(bytes2)}`;
    } else {
      throw Error("Unknown type, must be binary type");
    }
  }
};
__name(Encoder, "Encoder");
var Decoder = class {
  name;
  prefix;
  baseDecode;
  prefixCodePoint;
  constructor(name5, prefix2, baseDecode) {
    this.name = name5;
    this.prefix = prefix2;
    const prefixCodePoint = prefix2.codePointAt(0);
    if (prefixCodePoint === void 0) {
      throw new Error("Invalid prefix character");
    }
    this.prefixCodePoint = prefixCodePoint;
    this.baseDecode = baseDecode;
  }
  decode(text) {
    if (typeof text === "string") {
      if (text.codePointAt(0) !== this.prefixCodePoint) {
        throw Error(`Unable to decode multibase string ${JSON.stringify(text)}, ${this.name} decoder only supports inputs prefixed with ${this.prefix}`);
      }
      return this.baseDecode(text.slice(this.prefix.length));
    } else {
      throw Error("Can only multibase decode strings");
    }
  }
  or(decoder) {
    return or(this, decoder);
  }
};
__name(Decoder, "Decoder");
var ComposedDecoder = class {
  decoders;
  constructor(decoders) {
    this.decoders = decoders;
  }
  or(decoder) {
    return or(this, decoder);
  }
  decode(input) {
    const prefix2 = input[0];
    const decoder = this.decoders[prefix2];
    if (decoder != null) {
      return decoder.decode(input);
    } else {
      throw RangeError(`Unable to decode multibase string ${JSON.stringify(input)}, only inputs prefixed with ${Object.keys(this.decoders)} are supported`);
    }
  }
};
__name(ComposedDecoder, "ComposedDecoder");
function or(left, right) {
  return new ComposedDecoder({
    ...left.decoders ?? { [left.prefix]: left },
    ...right.decoders ?? { [right.prefix]: right }
  });
}
__name(or, "or");
var Codec = class {
  name;
  prefix;
  baseEncode;
  baseDecode;
  encoder;
  decoder;
  constructor(name5, prefix2, baseEncode, baseDecode) {
    this.name = name5;
    this.prefix = prefix2;
    this.baseEncode = baseEncode;
    this.baseDecode = baseDecode;
    this.encoder = new Encoder(name5, prefix2, baseEncode);
    this.decoder = new Decoder(name5, prefix2, baseDecode);
  }
  encode(input) {
    return this.encoder.encode(input);
  }
  decode(input) {
    return this.decoder.decode(input);
  }
};
__name(Codec, "Codec");
function from2({ name: name5, prefix: prefix2, encode: encode5, decode: decode7 }) {
  return new Codec(name5, prefix2, encode5, decode7);
}
__name(from2, "from");
function baseX({ name: name5, prefix: prefix2, alphabet }) {
  const { encode: encode5, decode: decode7 } = base_x_default(alphabet, name5);
  return from2({
    prefix: prefix2,
    name: name5,
    encode: encode5,
    decode: (text) => coerce(decode7(text))
  });
}
__name(baseX, "baseX");
function decode2(string, alphabetIdx, bitsPerChar, name5) {
  let end = string.length;
  while (string[end - 1] === "=") {
    --end;
  }
  const out = new Uint8Array(end * bitsPerChar / 8 | 0);
  let bits = 0;
  let buffer2 = 0;
  let written = 0;
  for (let i = 0; i < end; ++i) {
    const value = alphabetIdx[string[i]];
    if (value === void 0) {
      throw new SyntaxError(`Non-${name5} character`);
    }
    buffer2 = buffer2 << bitsPerChar | value;
    bits += bitsPerChar;
    if (bits >= 8) {
      bits -= 8;
      out[written++] = 255 & buffer2 >> bits;
    }
  }
  if (bits >= bitsPerChar || (255 & buffer2 << 8 - bits) !== 0) {
    throw new SyntaxError("Unexpected end of data");
  }
  return out;
}
__name(decode2, "decode");
function encode2(data, alphabet, bitsPerChar) {
  const pad3 = alphabet[alphabet.length - 1] === "=";
  const mask = (1 << bitsPerChar) - 1;
  let out = "";
  let bits = 0;
  let buffer2 = 0;
  for (let i = 0; i < data.length; ++i) {
    buffer2 = buffer2 << 8 | data[i];
    bits += 8;
    while (bits > bitsPerChar) {
      bits -= bitsPerChar;
      out += alphabet[mask & buffer2 >> bits];
    }
  }
  if (bits !== 0) {
    out += alphabet[mask & buffer2 << bitsPerChar - bits];
  }
  if (pad3) {
    while ((out.length * bitsPerChar & 7) !== 0) {
      out += "=";
    }
  }
  return out;
}
__name(encode2, "encode");
function createAlphabetIdx(alphabet) {
  const alphabetIdx = {};
  for (let i = 0; i < alphabet.length; ++i) {
    alphabetIdx[alphabet[i]] = i;
  }
  return alphabetIdx;
}
__name(createAlphabetIdx, "createAlphabetIdx");
function rfc4648({ name: name5, prefix: prefix2, bitsPerChar, alphabet }) {
  const alphabetIdx = createAlphabetIdx(alphabet);
  return from2({
    prefix: prefix2,
    name: name5,
    encode(input) {
      return encode2(input, alphabet, bitsPerChar);
    },
    decode(input) {
      return decode2(input, alphabetIdx, bitsPerChar, name5);
    }
  });
}
__name(rfc4648, "rfc4648");

// node_modules/multiformats/dist/src/bases/base32.js
var base32 = rfc4648({
  prefix: "b",
  name: "base32",
  alphabet: "abcdefghijklmnopqrstuvwxyz234567",
  bitsPerChar: 5
});
var base32upper = rfc4648({
  prefix: "B",
  name: "base32upper",
  alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
  bitsPerChar: 5
});
var base32pad = rfc4648({
  prefix: "c",
  name: "base32pad",
  alphabet: "abcdefghijklmnopqrstuvwxyz234567=",
  bitsPerChar: 5
});
var base32padupper = rfc4648({
  prefix: "C",
  name: "base32padupper",
  alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567=",
  bitsPerChar: 5
});
var base32hex = rfc4648({
  prefix: "v",
  name: "base32hex",
  alphabet: "0123456789abcdefghijklmnopqrstuv",
  bitsPerChar: 5
});
var base32hexupper = rfc4648({
  prefix: "V",
  name: "base32hexupper",
  alphabet: "0123456789ABCDEFGHIJKLMNOPQRSTUV",
  bitsPerChar: 5
});
var base32hexpad = rfc4648({
  prefix: "t",
  name: "base32hexpad",
  alphabet: "0123456789abcdefghijklmnopqrstuv=",
  bitsPerChar: 5
});
var base32hexpadupper = rfc4648({
  prefix: "T",
  name: "base32hexpadupper",
  alphabet: "0123456789ABCDEFGHIJKLMNOPQRSTUV=",
  bitsPerChar: 5
});
var base32z = rfc4648({
  prefix: "h",
  name: "base32z",
  alphabet: "ybndrfg8ejkmcpqxot1uwisza345h769",
  bitsPerChar: 5
});

// node_modules/multiformats/dist/src/bases/base36.js
var base36 = baseX({
  prefix: "k",
  name: "base36",
  alphabet: "0123456789abcdefghijklmnopqrstuvwxyz"
});
var base36upper = baseX({
  prefix: "K",
  name: "base36upper",
  alphabet: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
});

// node_modules/multiformats/dist/src/bases/base58.js
var base58btc = baseX({
  name: "base58btc",
  prefix: "z",
  alphabet: "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
});
var base58flickr = baseX({
  name: "base58flickr",
  prefix: "Z",
  alphabet: "123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"
});

// node_modules/multiformats/dist/src/varint.js
var varint_exports = {};
__export(varint_exports, {
  decode: () => decode4,
  encodeTo: () => encodeTo,
  encodingLength: () => encodingLength
});

// node_modules/multiformats/dist/src/vendor/varint.js
var encode_1 = encode3;
var MSB = 128;
var REST = 127;
var MSBALL = ~REST;
var INT = Math.pow(2, 31);
function encode3(num, out, offset2) {
  out = out || [];
  offset2 = offset2 || 0;
  var oldOffset = offset2;
  while (num >= INT) {
    out[offset2++] = num & 255 | MSB;
    num /= 128;
  }
  while (num & MSBALL) {
    out[offset2++] = num & 255 | MSB;
    num >>>= 7;
  }
  out[offset2] = num | 0;
  encode3.bytes = offset2 - oldOffset + 1;
  return out;
}
__name(encode3, "encode");
var decode3 = read;
var MSB$1 = 128;
var REST$1 = 127;
function read(buf, offset2) {
  var res = 0, offset2 = offset2 || 0, shift = 0, counter = offset2, b, l = buf.length;
  do {
    if (counter >= l) {
      read.bytes = 0;
      throw new RangeError("Could not decode varint");
    }
    b = buf[counter++];
    res += shift < 28 ? (b & REST$1) << shift : (b & REST$1) * Math.pow(2, shift);
    shift += 7;
  } while (b >= MSB$1);
  read.bytes = counter - offset2;
  return res;
}
__name(read, "read");
var N1 = Math.pow(2, 7);
var N2 = Math.pow(2, 14);
var N3 = Math.pow(2, 21);
var N4 = Math.pow(2, 28);
var N5 = Math.pow(2, 35);
var N6 = Math.pow(2, 42);
var N7 = Math.pow(2, 49);
var N8 = Math.pow(2, 56);
var N9 = Math.pow(2, 63);
var length = /* @__PURE__ */ __name(function(value) {
  return value < N1 ? 1 : value < N2 ? 2 : value < N3 ? 3 : value < N4 ? 4 : value < N5 ? 5 : value < N6 ? 6 : value < N7 ? 7 : value < N8 ? 8 : value < N9 ? 9 : 10;
}, "length");
var varint = {
  encode: encode_1,
  decode: decode3,
  encodingLength: length
};
var _brrp_varint = varint;
var varint_default = _brrp_varint;

// node_modules/multiformats/dist/src/varint.js
function decode4(data, offset2 = 0) {
  const code7 = varint_default.decode(data, offset2);
  return [code7, varint_default.decode.bytes];
}
__name(decode4, "decode");
function encodeTo(int, target, offset2 = 0) {
  varint_default.encode(int, target, offset2);
  return target;
}
__name(encodeTo, "encodeTo");
function encodingLength(int) {
  return varint_default.encodingLength(int);
}
__name(encodingLength, "encodingLength");

// node_modules/multiformats/dist/src/hashes/digest.js
function create(code7, digest3) {
  const size3 = digest3.byteLength;
  const sizeOffset = encodingLength(code7);
  const digestOffset = sizeOffset + encodingLength(size3);
  const bytes2 = new Uint8Array(digestOffset + size3);
  encodeTo(code7, bytes2, 0);
  encodeTo(size3, bytes2, sizeOffset);
  bytes2.set(digest3, digestOffset);
  return new Digest2(code7, size3, digest3, bytes2);
}
__name(create, "create");
function decode5(multihash) {
  const bytes2 = coerce(multihash);
  const [code7, sizeOffset] = decode4(bytes2);
  const [size3, digestOffset] = decode4(bytes2.subarray(sizeOffset));
  const digest3 = bytes2.subarray(sizeOffset + digestOffset);
  if (digest3.byteLength !== size3) {
    throw new Error("Incorrect length");
  }
  return new Digest2(code7, size3, digest3, bytes2);
}
__name(decode5, "decode");
function equals2(a, b) {
  if (a === b) {
    return true;
  } else {
    const data = b;
    return a.code === data.code && a.size === data.size && data.bytes instanceof Uint8Array && equals(a.bytes, data.bytes);
  }
}
__name(equals2, "equals");
var Digest2 = class {
  code;
  size;
  digest;
  bytes;
  /**
   * Creates a multihash digest.
   */
  constructor(code7, size3, digest3, bytes2) {
    this.code = code7;
    this.size = size3;
    this.digest = digest3;
    this.bytes = bytes2;
  }
};
__name(Digest2, "Digest");

// node_modules/multiformats/dist/src/cid.js
function format(link, base2) {
  const { bytes: bytes2, version: version2 } = link;
  switch (version2) {
    case 0:
      return toStringV0(bytes2, baseCache(link), base2 ?? base58btc.encoder);
    default:
      return toStringV1(bytes2, baseCache(link), base2 ?? base32.encoder);
  }
}
__name(format, "format");
var cache = /* @__PURE__ */ new WeakMap();
function baseCache(cid) {
  const baseCache2 = cache.get(cid);
  if (baseCache2 == null) {
    const baseCache3 = /* @__PURE__ */ new Map();
    cache.set(cid, baseCache3);
    return baseCache3;
  }
  return baseCache2;
}
__name(baseCache, "baseCache");
var CID = class {
  code;
  version;
  multihash;
  bytes;
  "/";
  /**
   * @param version - Version of the CID
   * @param code - Code of the codec content is encoded in, see https://github.com/multiformats/multicodec/blob/master/table.csv
   * @param multihash - (Multi)hash of the of the content.
   */
  constructor(version2, code7, multihash, bytes2) {
    this.code = code7;
    this.version = version2;
    this.multihash = multihash;
    this.bytes = bytes2;
    this["/"] = bytes2;
  }
  /**
   * Signalling `cid.asCID === cid` has been replaced with `cid['/'] === cid.bytes`
   * please either use `CID.asCID(cid)` or switch to new signalling mechanism
   *
   * @deprecated
   */
  get asCID() {
    return this;
  }
  // ArrayBufferView
  get byteOffset() {
    return this.bytes.byteOffset;
  }
  // ArrayBufferView
  get byteLength() {
    return this.bytes.byteLength;
  }
  toV0() {
    switch (this.version) {
      case 0: {
        return this;
      }
      case 1: {
        const { code: code7, multihash } = this;
        if (code7 !== DAG_PB_CODE) {
          throw new Error("Cannot convert a non dag-pb CID to CIDv0");
        }
        if (multihash.code !== SHA_256_CODE) {
          throw new Error("Cannot convert non sha2-256 multihash CID to CIDv0");
        }
        return CID.createV0(multihash);
      }
      default: {
        throw Error(`Can not convert CID version ${this.version} to version 0. This is a bug please report`);
      }
    }
  }
  toV1() {
    switch (this.version) {
      case 0: {
        const { code: code7, digest: digest3 } = this.multihash;
        const multihash = create(code7, digest3);
        return CID.createV1(this.code, multihash);
      }
      case 1: {
        return this;
      }
      default: {
        throw Error(`Can not convert CID version ${this.version} to version 1. This is a bug please report`);
      }
    }
  }
  equals(other) {
    return CID.equals(this, other);
  }
  static equals(self, other) {
    const unknown = other;
    return unknown != null && self.code === unknown.code && self.version === unknown.version && equals2(self.multihash, unknown.multihash);
  }
  toString(base2) {
    return format(this, base2);
  }
  toJSON() {
    return { "/": format(this) };
  }
  link() {
    return this;
  }
  [Symbol.toStringTag] = "CID";
  // Legacy
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `CID(${this.toString()})`;
  }
  /**
   * Takes any input `value` and returns a `CID` instance if it was
   * a `CID` otherwise returns `null`. If `value` is instanceof `CID`
   * it will return value back. If `value` is not instance of this CID
   * class, but is compatible CID it will return new instance of this
   * `CID` class. Otherwise returns null.
   *
   * This allows two different incompatible versions of CID library to
   * co-exist and interop as long as binary interface is compatible.
   */
  static asCID(input) {
    if (input == null) {
      return null;
    }
    const value = input;
    if (value instanceof CID) {
      return value;
    } else if (value["/"] != null && value["/"] === value.bytes || value.asCID === value) {
      const { version: version2, code: code7, multihash, bytes: bytes2 } = value;
      return new CID(version2, code7, multihash, bytes2 ?? encodeCID(version2, code7, multihash.bytes));
    } else if (value[cidSymbol] === true) {
      const { version: version2, multihash, code: code7 } = value;
      const digest3 = decode5(multihash);
      return CID.create(version2, code7, digest3);
    } else {
      return null;
    }
  }
  /**
   * @param version - Version of the CID
   * @param code - Code of the codec content is encoded in, see https://github.com/multiformats/multicodec/blob/master/table.csv
   * @param digest - (Multi)hash of the of the content.
   */
  static create(version2, code7, digest3) {
    if (typeof code7 !== "number") {
      throw new Error("String codecs are no longer supported");
    }
    if (!(digest3.bytes instanceof Uint8Array)) {
      throw new Error("Invalid digest");
    }
    switch (version2) {
      case 0: {
        if (code7 !== DAG_PB_CODE) {
          throw new Error(`Version 0 CID must use dag-pb (code: ${DAG_PB_CODE}) block encoding`);
        } else {
          return new CID(version2, code7, digest3, digest3.bytes);
        }
      }
      case 1: {
        const bytes2 = encodeCID(version2, code7, digest3.bytes);
        return new CID(version2, code7, digest3, bytes2);
      }
      default: {
        throw new Error("Invalid version");
      }
    }
  }
  /**
   * Simplified version of `create` for CIDv0.
   */
  static createV0(digest3) {
    return CID.create(0, DAG_PB_CODE, digest3);
  }
  /**
   * Simplified version of `create` for CIDv1.
   *
   * @param code - Content encoding format code.
   * @param digest - Multihash of the content.
   */
  static createV1(code7, digest3) {
    return CID.create(1, code7, digest3);
  }
  /**
   * Decoded a CID from its binary representation. The byte array must contain
   * only the CID with no additional bytes.
   *
   * An error will be thrown if the bytes provided do not contain a valid
   * binary representation of a CID.
   */
  static decode(bytes2) {
    const [cid, remainder] = CID.decodeFirst(bytes2);
    if (remainder.length !== 0) {
      throw new Error("Incorrect length");
    }
    return cid;
  }
  /**
   * Decoded a CID from its binary representation at the beginning of a byte
   * array.
   *
   * Returns an array with the first element containing the CID and the second
   * element containing the remainder of the original byte array. The remainder
   * will be a zero-length byte array if the provided bytes only contained a
   * binary CID representation.
   */
  static decodeFirst(bytes2) {
    const specs = CID.inspectBytes(bytes2);
    const prefixSize = specs.size - specs.multihashSize;
    const multihashBytes = coerce(bytes2.subarray(prefixSize, prefixSize + specs.multihashSize));
    if (multihashBytes.byteLength !== specs.multihashSize) {
      throw new Error("Incorrect length");
    }
    const digestBytes = multihashBytes.subarray(specs.multihashSize - specs.digestSize);
    const digest3 = new Digest2(specs.multihashCode, specs.digestSize, digestBytes, multihashBytes);
    const cid = specs.version === 0 ? CID.createV0(digest3) : CID.createV1(specs.codec, digest3);
    return [cid, bytes2.subarray(specs.size)];
  }
  /**
   * Inspect the initial bytes of a CID to determine its properties.
   *
   * Involves decoding up to 4 varints. Typically this will require only 4 to 6
   * bytes but for larger multicodec code values and larger multihash digest
   * lengths these varints can be quite large. It is recommended that at least
   * 10 bytes be made available in the `initialBytes` argument for a complete
   * inspection.
   */
  static inspectBytes(initialBytes) {
    let offset2 = 0;
    const next = /* @__PURE__ */ __name(() => {
      const [i, length2] = decode4(initialBytes.subarray(offset2));
      offset2 += length2;
      return i;
    }, "next");
    let version2 = next();
    let codec = DAG_PB_CODE;
    if (version2 === 18) {
      version2 = 0;
      offset2 = 0;
    } else {
      codec = next();
    }
    if (version2 !== 0 && version2 !== 1) {
      throw new RangeError(`Invalid CID version ${version2}`);
    }
    const prefixSize = offset2;
    const multihashCode = next();
    const digestSize = next();
    const size3 = offset2 + digestSize;
    const multihashSize = size3 - prefixSize;
    return { version: version2, codec, multihashCode, digestSize, multihashSize, size: size3 };
  }
  /**
   * Takes cid in a string representation and creates an instance. If `base`
   * decoder is not provided will use a default from the configuration. It will
   * throw an error if encoding of the CID is not compatible with supplied (or
   * a default decoder).
   */
  static parse(source, base2) {
    const [prefix2, bytes2] = parseCIDtoBytes(source, base2);
    const cid = CID.decode(bytes2);
    if (cid.version === 0 && source[0] !== "Q") {
      throw Error("Version 0 CID string must not include multibase prefix");
    }
    baseCache(cid).set(prefix2, source);
    return cid;
  }
};
__name(CID, "CID");
function parseCIDtoBytes(source, base2) {
  switch (source[0]) {
    case "Q": {
      const decoder = base2 ?? base58btc;
      return [
        base58btc.prefix,
        decoder.decode(`${base58btc.prefix}${source}`)
      ];
    }
    case base58btc.prefix: {
      const decoder = base2 ?? base58btc;
      return [base58btc.prefix, decoder.decode(source)];
    }
    case base32.prefix: {
      const decoder = base2 ?? base32;
      return [base32.prefix, decoder.decode(source)];
    }
    case base36.prefix: {
      const decoder = base2 ?? base36;
      return [base36.prefix, decoder.decode(source)];
    }
    default: {
      if (base2 == null) {
        throw Error("To parse non base32, base36 or base58btc encoded CID multibase decoder must be provided");
      }
      return [source[0], base2.decode(source)];
    }
  }
}
__name(parseCIDtoBytes, "parseCIDtoBytes");
function toStringV0(bytes2, cache2, base2) {
  const { prefix: prefix2 } = base2;
  if (prefix2 !== base58btc.prefix) {
    throw Error(`Cannot string encode V0 in ${base2.name} encoding`);
  }
  const cid = cache2.get(prefix2);
  if (cid == null) {
    const cid2 = base2.encode(bytes2).slice(1);
    cache2.set(prefix2, cid2);
    return cid2;
  } else {
    return cid;
  }
}
__name(toStringV0, "toStringV0");
function toStringV1(bytes2, cache2, base2) {
  const { prefix: prefix2 } = base2;
  const cid = cache2.get(prefix2);
  if (cid == null) {
    const cid2 = base2.encode(bytes2);
    cache2.set(prefix2, cid2);
    return cid2;
  } else {
    return cid;
  }
}
__name(toStringV1, "toStringV1");
var DAG_PB_CODE = 112;
var SHA_256_CODE = 18;
function encodeCID(version2, code7, multihash) {
  const codeOffset = encodingLength(version2);
  const hashOffset = codeOffset + encodingLength(code7);
  const bytes2 = new Uint8Array(hashOffset + multihash.byteLength);
  encodeTo(version2, bytes2, 0);
  encodeTo(code7, bytes2, codeOffset);
  bytes2.set(multihash, hashOffset);
  return bytes2;
}
__name(encodeCID, "encodeCID");
var cidSymbol = Symbol.for("@ipld/js-cid/CID");

// node_modules/@ipld/dag-cbor/src/index.js
var CID_CBOR_TAG = 42;
function cidEncoder(obj) {
  if (obj.asCID !== obj && obj["/"] !== obj.bytes) {
    return null;
  }
  const cid = CID.asCID(obj);
  if (!cid) {
    return null;
  }
  const bytes2 = new Uint8Array(cid.bytes.byteLength + 1);
  bytes2.set(cid.bytes, 1);
  return [
    new Token(Type.tag, CID_CBOR_TAG),
    new Token(Type.bytes, bytes2)
  ];
}
__name(cidEncoder, "cidEncoder");
function undefinedEncoder() {
  throw new Error("`undefined` is not supported by the IPLD Data Model and cannot be encoded");
}
__name(undefinedEncoder, "undefinedEncoder");
function numberEncoder(num) {
  if (Number.isNaN(num)) {
    throw new Error("`NaN` is not supported by the IPLD Data Model and cannot be encoded");
  }
  if (num === Infinity || num === -Infinity) {
    throw new Error("`Infinity` and `-Infinity` is not supported by the IPLD Data Model and cannot be encoded");
  }
  return null;
}
__name(numberEncoder, "numberEncoder");
function mapEncoder(map) {
  for (const key of map.keys()) {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("Non-string Map keys are not supported by the IPLD Data Model and cannot be encoded");
    }
  }
  return null;
}
__name(mapEncoder, "mapEncoder");
var _encodeOptions = {
  float64: true,
  typeEncoders: {
    Map: mapEncoder,
    Object: cidEncoder,
    undefined: undefinedEncoder,
    number: numberEncoder
  }
};
var encodeOptions = {
  ..._encodeOptions,
  typeEncoders: {
    ..._encodeOptions.typeEncoders
  }
};
function cidDecoder(decode7) {
  const bytes2 = (
    /** @type {Uint8Array} */
    decode7()
  );
  if (bytes2[0] !== 0) {
    throw new Error("Invalid CID for CBOR tag 42; expected leading 0x00");
  }
  return CID.decode(bytes2.subarray(1));
}
__name(cidDecoder, "cidDecoder");
var _decodeOptions = {
  allowIndefinite: false,
  coerceUndefinedToNull: true,
  allowNaN: false,
  allowInfinity: false,
  allowBigInt: true,
  // this will lead to BigInt for ints outside of
  // safe-integer range, which may surprise users
  strict: true,
  useMaps: false,
  rejectDuplicateMapKeys: true,
  /** @type {{ [tagNumber: number]: import('cborg').TagDecoder }} */
  tags: { [CID_CBOR_TAG]: cidDecoder }
};
var decodeOptions = {
  ..._decodeOptions,
  tags: { ..._decodeOptions.tags }
};

// node_modules/multiformats/dist/src/link.js
function create2(code7, digest3) {
  return CID.create(1, code7, digest3);
}
__name(create2, "create");
function parse(source, base2) {
  return CID.parse(source, base2);
}
__name(parse, "parse");

// node_modules/@web3-storage/data-segment/src/proof.js
function truncatedHash(payload, options = {}) {
  const hasher = options.hasher || sha256_exports;
  const { digest: digest3 } = hasher.digest(payload);
  return truncate(digest3);
}
__name(truncatedHash, "truncatedHash");
var computeNode = /* @__PURE__ */ __name((left, right, options) => {
  const payload = new Uint8Array(left.length + right.length);
  payload.set(left, 0);
  payload.set(right, left.length);
  return truncatedHash(payload, options);
}, "computeNode");
function truncate(node) {
  node[NODE_SIZE - 1] &= 63;
  return node;
}
__name(truncate, "truncate");

// node_modules/@web3-storage/data-segment/src/piece.js
var piece_exports = {};
__export(piece_exports, {
  FilCommitmentUnsealed: () => FilCommitmentUnsealed,
  MAX_PAYLOAD_SIZE: () => MAX_PAYLOAD_SIZE2,
  Sha256Trunc254Padded: () => Sha256Trunc254Padded,
  Size: () => size_exports,
  fromDigest: () => fromDigest,
  fromInfo: () => fromInfo,
  fromJSON: () => fromJSON2,
  fromLink: () => fromLink,
  fromPayload: () => fromPayload,
  fromString: () => fromString2,
  toInfo: () => toInfo,
  toJSON: () => toJSON2,
  toLink: () => toLink,
  toString: () => toString,
  toView: () => toView
});

// node_modules/@web3-storage/data-segment/src/piece/size/expanded.js
var expanded_exports = {};
__export(expanded_exports, {
  from: () => from4,
  fromHeight: () => fromHeight2,
  fromPadded: () => toExpanded,
  fromUnpadded: () => toExpanded2,
  fromWidth: () => fromWidth2,
  toHeight: () => toHeight3,
  toPadded: () => fromExpanded,
  toWidth: () => toWidth3,
  tryFrom: () => tryFrom2
});

// node_modules/@web3-storage/data-segment/src/uint64.js
var log2Floor = /* @__PURE__ */ __name((n) => {
  let result = 0n;
  while (n >>= 1n)
    result++;
  return Number(result);
}, "log2Floor");
var log2Ceil = /* @__PURE__ */ __name((n) => n <= 1n ? 0 : log2Floor(BigInt(n) - 1n) + 1, "log2Ceil");
var trailingZeros64 = /* @__PURE__ */ __name((n) => {
  if (n === 0n) {
    return 64;
  }
  let count = 0;
  while ((n & 1n) === 0n) {
    n >>= 1n;
    count++;
  }
  return count;
}, "trailingZeros64");
var onesCount64 = /* @__PURE__ */ __name((value) => {
  let count = 0;
  const mask = 1n;
  for (let i = 0n; i < 64n; i++) {
    if ((value & mask << i) !== 0n) {
      count++;
    }
  }
  return count;
}, "onesCount64");
var pow2 = /* @__PURE__ */ __name((n) => 1n << n, "pow2");

// node_modules/@web3-storage/data-segment/src/piece/size/padded.js
var padded_exports = {};
__export(padded_exports, {
  from: () => from3,
  fromExpanded: () => fromExpanded,
  fromHeight: () => fromHeight,
  fromWidth: () => fromWidth,
  toExpanded: () => toExpanded,
  toHeight: () => toHeight,
  toWidth: () => toWidth,
  tryFrom: () => tryFrom
});
var from3 = /* @__PURE__ */ __name((size3) => {
  const result = tryFrom(size3);
  if (result.error) {
    throw result.error;
  } else {
    return result.ok;
  }
}, "from");
var tryFrom = /* @__PURE__ */ __name((input) => {
  const size3 = BigInt(input);
  if (size3 < PADDED_BYTES_PER_QUAD) {
    return {
      error: new RangeError(
        `Padded payload must contain at least ${PADDED_BYTES_PER_QUAD} bytes`
      )
    };
  }
  if (size3 >> BigInt(trailingZeros64(size3)) !== PADDED_BYTES_PER_QUAD) {
    return {
      error: new RangeError(
        `Padded payload size must be (2\u207F * ${PADDED_BYTES_PER_QUAD})`
      )
    };
  }
  return { ok: size3 };
}, "tryFrom");
var fromExpanded = /* @__PURE__ */ __name((size3) => fromQuads(size3 / EXPANDED_BYTES_PER_QUAD), "fromExpanded");
var toExpanded = /* @__PURE__ */ __name((size3) => toQauds(size3) * EXPANDED_BYTES_PER_QUAD, "toExpanded");
var fromHeight = /* @__PURE__ */ __name((height2) => {
  const quads = 2n ** BigInt(height2 - 2);
  return quads * PADDED_BYTES_PER_QUAD;
}, "fromHeight");
var toHeight = /* @__PURE__ */ __name((size3) => log2Ceil(toWidth(size3)), "toHeight");
var toWidth = /* @__PURE__ */ __name((size3) => toQauds(size3) * LEAFS_PER_QUAD, "toWidth");
var fromWidth = /* @__PURE__ */ __name((width) => fromQuads(width / LEAFS_PER_QUAD), "fromWidth");
var toQauds = /* @__PURE__ */ __name((size3) => size3 / PADDED_BYTES_PER_QUAD, "toQauds");
var fromQuads = /* @__PURE__ */ __name((count) => count * PADDED_BYTES_PER_QUAD, "fromQuads");

// node_modules/@web3-storage/data-segment/src/piece/size/unpadded.js
var unpadded_exports = {};
__export(unpadded_exports, {
  fromPiece: () => fromPiece,
  toExpanded: () => toExpanded2,
  toHeight: () => toHeight2,
  toPadded: () => toPadded,
  toPadding: () => toPadding,
  toWidth: () => toWidth2
});
var fromPiece = /* @__PURE__ */ __name(({ height: height2, padding: padding2 }) => fromHeight(height2) - padding2, "fromPiece");
var toPadding = /* @__PURE__ */ __name((size3) => toPadded(size3) - size3, "toPadding");
var toPadded = /* @__PURE__ */ __name((size3) => toQauds2(size3) * PADDED_BYTES_PER_QUAD, "toPadded");
var toExpanded2 = /* @__PURE__ */ __name((size3) => toQauds2(size3) * EXPANDED_BYTES_PER_QUAD, "toExpanded");
var toWidth2 = /* @__PURE__ */ __name((size3) => toQauds2(size3) * LEAFS_PER_QUAD, "toWidth");
var toHeight2 = /* @__PURE__ */ __name((size3) => log2Ceil(toWidth2(size3)), "toHeight");
var toQauds2 = /* @__PURE__ */ __name((size3) => {
  const quadCount = (size3 + PADDED_BYTES_PER_QUAD - 1n) / PADDED_BYTES_PER_QUAD;
  return 2n ** BigInt(log2Ceil(quadCount));
}, "toQauds");

// node_modules/@web3-storage/data-segment/src/piece/size/expanded.js
var tryFrom2 = /* @__PURE__ */ __name((input) => {
  const size3 = BigInt(input);
  if (size3 < EXPANDED_BYTES_PER_QUAD) {
    return {
      error: RangeError(
        `Minimum piece size is ${EXPANDED_BYTES_PER_QUAD} bytes`
      )
    };
  }
  if (onesCount64(size3) !== 1) {
    return { error: RangeError("Piece size must be a power of 2") };
  }
  return { ok: size3 };
}, "tryFrom");
var from4 = /* @__PURE__ */ __name((size3) => {
  const result = tryFrom2(size3);
  if (result.error) {
    throw result.error;
  } else {
    return result.ok;
  }
}, "from");
var fromHeight2 = /* @__PURE__ */ __name((height2) => fromWidth2(2n ** BigInt(height2)), "fromHeight");
var toHeight3 = /* @__PURE__ */ __name((size3) => log2Ceil(toWidth3(size3)), "toHeight");
var fromWidth2 = /* @__PURE__ */ __name((width) => width * EXPANDED_BYTES_PER_NODE, "fromWidth");
var toWidth3 = /* @__PURE__ */ __name((size3) => size3 / EXPANDED_BYTES_PER_NODE, "toWidth");

// node_modules/@web3-storage/data-segment/src/digest.js
var name3 = (
  /** @type {const} */
  "fr32-sha2-256-trunc254-padded-binary-tree"
);
var code4 = 4113;
var MAX_PADDING_SIZE = 9;
var HEIGHT_SIZE = 1;
var ROOT_SIZE = sha256_exports.size;
var MAX_DIGEST_SIZE = MAX_PADDING_SIZE + HEIGHT_SIZE + sha256_exports.size;
var TAG_SIZE = varint_exports.encodingLength(code4);
var MAX_SIZE = TAG_SIZE + varint_exports.encodingLength(MAX_DIGEST_SIZE) + MAX_DIGEST_SIZE;
var MAX_HEIGHT = 255;
var MAX_PAYLOAD_SIZE = fromHeight2(MAX_HEIGHT) * BigInt(IN_BITS_FR) / BigInt(OUT_BITS_FR);
var fromPiece2 = /* @__PURE__ */ __name(({ padding: padding2, height: height2, root: root2 }) => {
  const paddingLength = varint_exports.encodingLength(Number(padding2));
  const size3 = paddingLength + HEIGHT_SIZE + ROOT_SIZE;
  const sizeLength = varint_exports.encodingLength(size3);
  const multihashLength = TAG_SIZE + sizeLength + size3;
  let offset2 = 0;
  const bytes2 = new Uint8Array(multihashLength);
  varint_exports.encodeTo(code4, bytes2, offset2);
  offset2 += TAG_SIZE;
  varint_exports.encodeTo(size3, bytes2, offset2);
  offset2 += sizeLength;
  varint_exports.encodeTo(Number(padding2), bytes2, offset2);
  offset2 += paddingLength;
  bytes2[offset2] = height2;
  offset2 += HEIGHT_SIZE;
  bytes2.set(root2, offset2);
  return new Digest3(bytes2);
}, "fromPiece");
var fromBytes = /* @__PURE__ */ __name((bytes2) => new Digest3(bytes2), "fromBytes");
var height = /* @__PURE__ */ __name(({ digest: digest3 }) => {
  const [, offset2] = varint_exports.decode(digest3);
  return digest3[offset2];
}, "height");
var padding = /* @__PURE__ */ __name(({ digest: digest3 }) => {
  const [padding2] = varint_exports.decode(digest3);
  return BigInt(padding2);
}, "padding");
var root = /* @__PURE__ */ __name(({ digest: digest3 }) => {
  const [, offset2] = varint_exports.decode(digest3);
  return digest3.subarray(
    offset2 + HEIGHT_SIZE,
    offset2 + HEIGHT_SIZE + sha256_exports.size
  );
}, "root");
var Digest3 = class {
  /**
   * @param {Uint8Array} bytes
   */
  constructor(bytes2) {
    this.bytes = bytes2;
    const [tag] = varint_exports.decode(bytes2);
    if (tag !== code4) {
      throw new RangeError(`Expected multihash with code ${code4}`);
    }
    let offset2 = TAG_SIZE;
    const [size3, length2] = varint_exports.decode(bytes2, offset2);
    offset2 += length2;
    const digest3 = bytes2.subarray(offset2);
    if (digest3.length !== size3) {
      throw new RangeError(
        `Invalid multihash size expected ${offset2 + size3} bytes, got ${bytes2.length} bytes`
      );
    }
    this.digest = digest3;
  }
  get name() {
    return name3;
  }
  get code() {
    return code4;
  }
  get size() {
    return this.digest.length;
  }
  get padding() {
    return padding(this);
  }
  get height() {
    return height(this);
  }
  get root() {
    return root(this);
  }
};
__name(Digest3, "Digest");

// node_modules/multiformats/dist/src/codecs/raw.js
var code5 = 85;

// node_modules/@web3-storage/data-segment/src/zero-comm.js
var MAX_LEVEL = 64;
var ZeroComm = class {
  constructor() {
    this.bytes = new Uint8Array(MAX_LEVEL * NODE_SIZE);
    this.bytes.set(empty(), 0);
    this.node = empty();
    this.length = NODE_SIZE;
  }
  /**
   * @param {number} start
   * @param {number} end
   */
  slice(start, end) {
    while (this.length < end) {
      this.node = computeNode(this.node, this.node);
      this.bytes.set(this.node, this.length);
      this.length += NODE_SIZE;
    }
    return this.bytes.subarray(start, end);
  }
};
__name(ZeroComm, "ZeroComm");
var ZERO_COMM = new ZeroComm();
var fromLevel = /* @__PURE__ */ __name((level) => {
  if (level < 0 || level >= MAX_LEVEL) {
    throw new Error(
      `Only levels between 0 and ${MAX_LEVEL - 1} inclusive are available`
    );
  }
  return ZERO_COMM.slice(NODE_SIZE * level, NODE_SIZE * (level + 1));
}, "fromLevel");

// node_modules/@web3-storage/data-segment/src/piece/tree.js
var MAX_LEAF_COUNT = 2 ** 32 - 1;
var split = /* @__PURE__ */ __name((source) => {
  const count = source.length / NODE_SIZE;
  const chunks = new Array(count);
  for (let n = 0; n < count; n++) {
    const offset2 = n * NODE_SIZE;
    const chunk = source.subarray(offset2, offset2 + NODE_SIZE);
    chunks[n] = chunk;
  }
  return chunks;
}, "split");

// node_modules/@web3-storage/data-segment/src/fr32.js
function toZeroPaddedSize(payloadSize) {
  const size3 = Math.max(payloadSize, MIN_PAYLOAD_SIZE);
  const highestBit = Math.floor(Math.log2(size3));
  const bound = Math.ceil(FR_RATIO * 2 ** (highestBit + 1));
  return size3 <= bound ? bound : Math.ceil(FR_RATIO * 2 ** (highestBit + 2));
}
__name(toZeroPaddedSize, "toZeroPaddedSize");
var toPieceSize = /* @__PURE__ */ __name((size3) => toZeroPaddedSize(size3) / FR_RATIO, "toPieceSize");
var pad = /* @__PURE__ */ __name((source, output2 = new Uint8Array(toPieceSize(source.length))) => {
  const size3 = toZeroPaddedSize(source.byteLength);
  const quadCount = size3 / IN_BYTES_PER_QUAD;
  for (let n = 0; n < quadCount; n++) {
    const readOffset = n * IN_BYTES_PER_QUAD;
    const writeOffset = n * OUT_BYTES_PER_QUAD;
    output2.set(source.subarray(readOffset, readOffset + 32), writeOffset);
    output2[writeOffset + 31] &= 63;
    for (let i = 32; i < 64; i++) {
      output2[writeOffset + i] = source[readOffset + i] << 2 | source[readOffset + i - 1] >> 6;
    }
    output2[writeOffset + 63] &= 63;
    for (let i = 64; i < 96; i++) {
      output2[writeOffset + i] = source[readOffset + i] << 4 | source[readOffset + i - 1] >> 4;
    }
    output2[writeOffset + 95] &= 63;
    for (let i = 96; i < 127; i++) {
      output2[writeOffset + i] = source[readOffset + i] << 6 | source[readOffset + i - 1] >> 2;
    }
    output2[writeOffset + 127] = source[readOffset + 126] >> 2;
  }
  return output2;
}, "pad");

// node_modules/@web3-storage/data-segment/src/piece/size.js
var size_exports = {};
__export(size_exports, {
  Expanded: () => expanded_exports,
  Padded: () => padded_exports,
  Unpadded: () => unpadded_exports,
  from: () => from4,
  fromHeight: () => fromHeight2,
  fromPadded: () => toExpanded,
  fromUnpadded: () => toExpanded2,
  fromWidth: () => fromWidth2,
  toHeight: () => toHeight3,
  toPadded: () => fromExpanded,
  toWidth: () => toWidth3,
  tryFrom: () => tryFrom2
});

// node_modules/@web3-storage/data-segment/src/multihash.js
var name4 = (
  /** @type {const} */
  "fr32-sha2-256-trunc254-padded-binary-tree"
);
var code6 = 4113;
var MAX_HEIGHT2 = 255;
var MAX_PAYLOAD_SIZE2 = fromHeight2(MAX_HEIGHT2) * BigInt(IN_BITS_FR) / BigInt(OUT_BITS_FR);
var digest2 = /* @__PURE__ */ __name((payload) => {
  const hasher = new Hasher();
  hasher.write(payload);
  return hasher.digest();
}, "digest");
var Hasher = class {
  constructor() {
    this.bytesWritten = 0n;
    this.buffer = new Uint8Array(IN_BYTES_PER_QUAD);
    this.offset = 0;
    this.layers = [[]];
  }
  /**
   * Return the total number of bytes written into the hasher. Calling
   * {@link reset} will reset the hasher and the count will be reset to 0.
   *
   * @returns {bigint}
   */
  count() {
    return this.bytesWritten;
  }
  /**
   * Computes the digest of all the data that has been written into this hasher.
   * This method does not have side-effects, meaning that you can continue
   * writing and call this method again to compute digest of all the data
   * written from the very beginning.
   */
  digest() {
    const bytes2 = new Uint8Array(MAX_SIZE);
    const count = this.digestInto(bytes2, 0, true);
    return fromBytes(bytes2.subarray(0, count));
  }
  /**
   * Computes the digest and writes into the given buffer. You can provide
   * optional `byteOffset` to write digest at that offset in the buffer. By
   * default the multihash prefix will be written into the buffer, but you can
   * opt-out by passing `false` as the `asMultihash` argument.
   *
   * @param {Uint8Array} output
   * @param {number} [byteOffset]
   * @param {boolean} asMultihash
   */
  digestInto(output2, byteOffset = 0, asMultihash = true) {
    const { buffer: buffer2, layers, offset: offset2, bytesWritten } = this;
    let [leaves, ...nodes] = layers;
    if (offset2 > 0 || bytesWritten === 0n) {
      leaves = [...leaves, ...split(pad(buffer2.fill(0, offset2)))];
    }
    const tree2 = build([leaves, ...nodes]);
    const height2 = tree2.length - 1;
    const [root2] = tree2[height2];
    const padding2 = Number(unpadded_exports.toPadding(this.bytesWritten));
    const paddingLength = varint_exports.encodingLength(
      /** @type {number & bigint} */
      padding2
    );
    let endOffset = byteOffset;
    if (asMultihash) {
      varint_exports.encodeTo(code6, output2, endOffset);
      endOffset += TAG_SIZE;
      const size3 = paddingLength + HEIGHT_SIZE + ROOT_SIZE;
      const sizeLength = varint_exports.encodingLength(size3);
      varint_exports.encodeTo(size3, output2, endOffset);
      endOffset += sizeLength;
    }
    varint_exports.encodeTo(padding2, output2, endOffset);
    endOffset += paddingLength;
    output2[endOffset] = height2;
    endOffset += 1;
    output2.set(root2, endOffset);
    endOffset += root2.length;
    return endOffset - byteOffset;
  }
  /**
   * @param {Uint8Array} bytes
   */
  write(bytes2) {
    const { buffer: buffer2, offset: offset2, layers } = this;
    const leaves = layers[0];
    const { length: length2 } = bytes2;
    if (length2 === 0) {
      return this;
    } else if (this.bytesWritten + BigInt(length2) > MAX_PAYLOAD_SIZE2) {
      throw new RangeError(
        `Writing ${length2} bytes exceeds max payload size of ${MAX_PAYLOAD_SIZE2}`
      );
    } else if (offset2 + length2 < buffer2.length) {
      buffer2.set(bytes2, offset2);
      this.offset += length2;
      this.bytesWritten += BigInt(length2);
      return this;
    } else {
      const bytesRequired = buffer2.length - offset2;
      buffer2.set(bytes2.subarray(0, bytesRequired), offset2);
      leaves.push(...split(pad(buffer2)));
      let readOffset = bytesRequired;
      while (readOffset + IN_BYTES_PER_QUAD < length2) {
        const quad = bytes2.subarray(readOffset, readOffset + IN_BYTES_PER_QUAD);
        leaves.push(...split(pad(quad)));
        readOffset += IN_BYTES_PER_QUAD;
      }
      this.buffer.set(bytes2.subarray(readOffset), 0);
      this.offset = length2 - readOffset;
      this.bytesWritten += BigInt(length2);
      prune(this.layers);
      return this;
    }
  }
  /**
   * Resets this hasher to its initial state so it could be recycled as new
   * instance.
   */
  reset() {
    this.offset = 0;
    this.bytesWritten = 0n;
    this.layers.length = 1;
    this.layers[0].length = 0;
    return this;
  }
  /* c8 ignore next 3 */
  dispose() {
    this.reset();
  }
  get code() {
    return code6;
  }
  get name() {
    return name4;
  }
};
__name(Hasher, "Hasher");
var prune = /* @__PURE__ */ __name((layers) => flush(layers, false), "prune");
var build = /* @__PURE__ */ __name((layers) => flush([...layers], true), "build");
var flush = /* @__PURE__ */ __name((layers, build2) => {
  let level = 0;
  while (level < layers.length) {
    let next = layers[level + 1];
    const layer = layers[level];
    if (build2 && layer.length % 2 > 0 && next) {
      layer.push(fromLevel(level));
    }
    level += 1;
    next = next ? build2 ? [...next] : next : [];
    let index2 = 0;
    while (index2 + 1 < layer.length) {
      const node = computeNode(layer[index2], layer[index2 + 1]);
      delete layer[index2];
      delete layer[index2 + 1];
      next.push(node);
      index2 += 2;
    }
    if (next.length) {
      layers[level] = next;
    }
    layer.splice(0, index2);
  }
  return layers;
}, "flush");

// node_modules/@web3-storage/data-segment/src/piece.js
var Sha256Trunc254Padded = 4114;
var FilCommitmentUnsealed = 61697;
var fromDigest = /* @__PURE__ */ __name((digest3) => fromLink(create2(code5, digest3)), "fromDigest");
var fromLink = /* @__PURE__ */ __name((link) => {
  if (link.code !== code5) {
    throw new TypeError(`Piece link must have raw encoding`);
  }
  if (link.multihash.code !== code6) {
    throw new Error(`Piece link must have ${name4} multihash`);
  }
  return new Piece(link);
}, "fromLink");
var fromString2 = /* @__PURE__ */ __name((source) => fromLink(parse(source)), "fromString");
var toString = /* @__PURE__ */ __name((piece) => `${toLink(piece)}`, "toString");
var fromJSON2 = /* @__PURE__ */ __name((json2) => fromString2(
  /** @type {{'/': string}} */
  json2["/"]
), "fromJSON");
var toJSON2 = /* @__PURE__ */ __name((piece) => ({ "/": toString(piece) }), "toJSON");
var fromPayload = /* @__PURE__ */ __name((payload) => fromDigest(digest2(payload)), "fromPayload");
var toView = /* @__PURE__ */ __name((piece) => fromDigest(fromPiece2(piece)), "toView");
var toLink = /* @__PURE__ */ __name((piece) => create2(code5, fromPiece2(piece)), "toLink");
var toInfo = /* @__PURE__ */ __name((piece) => new Info(fromPiece2(piece)), "toInfo");
var fromInfo = /* @__PURE__ */ __name((info) => toView({
  height: toHeight3(info.size),
  root: info.link.multihash.digest,
  padding: 0n
}), "fromInfo");
var Piece = class {
  /**
   * @param {API.PieceLink} link
   */
  constructor(link) {
    this.link = link;
  }
  get padding() {
    return padding(this.link.multihash);
  }
  get height() {
    return height(this.link.multihash);
  }
  get size() {
    return fromHeight2(this.height);
  }
  get root() {
    return root(this.link.multihash);
  }
  toJSON() {
    return {
      "/": this.toString()
    };
  }
  toString() {
    return (
      /** @type {API.ToString<API.PieceLink>} */
      this.link.toString()
    );
  }
  toInfo() {
    return new Info(this);
  }
};
__name(Piece, "Piece");
var Info = class {
  /**
   * @param {API.Piece} piece
   */
  constructor(piece) {
    this.piece = piece;
    this._link;
  }
  get height() {
    return this.piece.height;
  }
  get root() {
    return this.piece.root;
  }
  get size() {
    return fromHeight2(this.height);
  }
  get padding() {
    return this.piece.padding;
  }
  get link() {
    if (this._link == null) {
      this._link = create2(
        FilCommitmentUnsealed,
        create(Sha256Trunc254Padded, this.root)
      );
    }
    return this._link;
  }
  toJSON() {
    return {
      link: { "/": this.link.toString() },
      height: this.height
    };
  }
  toString() {
    return JSON.stringify(this.toJSON(), null, 2);
  }
};
__name(Info, "Info");

// node_modules/@web3-storage/data-segment/src/aggregate/tree.js
var MAX_HEIGHT3 = 60;
var SparseBlockLog2Size = 8;
var SparseBlockSize = 1 << SparseBlockLog2Size;
var BigIntSparseBlockSize = BigInt(SparseBlockSize);

// node_modules/@web3-storage/data-segment/src/segment.js
var segment_exports = {};
__export(segment_exports, {
  ChecksumSize: () => ChecksumSize,
  Uint64Size: () => Uint64Size,
  computeChecksum: () => computeChecksum,
  fromSource: () => fromSource,
  fromSourceWithChecksum: () => fromSourceWithChecksum,
  toBytes: () => toBytes2,
  toIndexNode: () => toIndexNode,
  toLeafIndex: () => toLeafIndex,
  toSource: () => toSource,
  validate: () => validate,
  withChecksum: () => withChecksum
});
var ChecksumSize = 16;
var Uint64Size = 64 / 8;
var computeChecksum = /* @__PURE__ */ __name((segment, options) => (
  /** Take only the first {@link ChecksumSize} bytes */
  toBytes2(segment, options).subarray(NODE_SIZE + Uint64Size + Uint64Size)
), "computeChecksum");
var withChecksum = /* @__PURE__ */ __name((segment, options) => ({
  ...segment,
  checksum: computeChecksum(segment, options)
}), "withChecksum");
var fromSource = /* @__PURE__ */ __name(({ node, location }) => ({
  root: node,
  offset: toLeafIndex(location) * BigInt(NODE_SIZE),
  size: pow2(BigInt(location.level)) * BigInt(NODE_SIZE)
}), "fromSource");
var toSource = /* @__PURE__ */ __name((segment) => {
  const level = log2Ceil(segment.size / BigInt(NODE_SIZE));
  return {
    node: segment.root,
    location: {
      level,
      index: segment.offset / BigInt(NODE_SIZE) >> BigInt(level)
    }
  };
}, "toSource");
var fromSourceWithChecksum = /* @__PURE__ */ __name((source, options) => withChecksum(fromSource(source), options), "fromSourceWithChecksum");
var toLeafIndex = /* @__PURE__ */ __name(({ index: index2, level }) => (
  // This is done by bit shifting Index to the left by `level` places.
  // In the context of a binary tree, this operation essentially corresponds to
  // descending `level` levels down from the current node.
  index2 << BigInt(level)
), "toLeafIndex");
var toIndexNode = /* @__PURE__ */ __name((segment) => toBytes2(segment).subarray(NODE_SIZE), "toIndexNode");
var toBytes2 = /* @__PURE__ */ __name(({ root: root2, size: size3, offset: offset2, checksum }, options = {}) => {
  const buffer2 = new Uint8Array(
    NODE_SIZE + Uint64Size + Uint64Size + ChecksumSize
  );
  buffer2.set(root2, 0);
  const view = new DataView(buffer2.buffer);
  view.setBigUint64(NODE_SIZE, BigInt(offset2), true);
  view.setBigUint64(NODE_SIZE + Uint64Size, BigInt(size3), true);
  if (!checksum) {
    const hasher = options.hasher || web_exports;
    const { digest: digest3 } = hasher.digest(buffer2);
    checksum = digest3.subarray(0, ChecksumSize);
    checksum[ChecksumSize - 1] &= 63;
  }
  buffer2.set(checksum, NODE_SIZE + Uint64Size + Uint64Size);
  return buffer2;
}, "toBytes");
var validate = /* @__PURE__ */ __name((segment) => {
  if (segment.offset % 128n !== 0n) {
    return { error: Error("offset is not aligned in padded data") };
  }
  return { ok: segment };
}, "validate");

// node_modules/@web3-storage/data-segment/src/index.js
var { Uint64Size: Uint64Size2, ChecksumSize: ChecksumSize2 } = segment_exports;
var EntrySize = BigInt(
  NODE_SIZE + Uint64Size2 + Uint64Size2 + ChecksumSize2
);

// node_modules/@web3-storage/data-segment/src/aggregate.js
var NodeSize = BigInt(NODE_SIZE);
var EntrySize2 = Number(EntrySize);
var MAX_CAPACITY = expanded_exports.fromHeight(MAX_HEIGHT3);
var DEFAULT_DEAL_SIZE = expanded_exports.from(2n ** 35n);

// node_modules/viem/_esm/errors/version.js
var version = "2.57.7";

// node_modules/viem/_esm/errors/base.js
var errorConfig = {
  getDocsUrl: ({ docsBaseUrl, docsPath = "", docsSlug }) => docsPath ? `${docsBaseUrl ?? "https://viem.sh"}${docsPath}${docsSlug ? `#${docsSlug}` : ""}` : void 0,
  version: `viem@${version}`
};
var BaseError = class extends Error {
  constructor(shortMessage, args = {}) {
    const details = (() => {
      if (args.cause instanceof BaseError)
        return args.cause.details;
      if (args.cause?.message)
        return args.cause.message;
      return args.details;
    })();
    const docsPath = (() => {
      if (args.cause instanceof BaseError)
        return args.cause.docsPath || args.docsPath;
      return args.docsPath;
    })();
    const docsUrl = errorConfig.getDocsUrl?.({ ...args, docsPath });
    const message = [
      shortMessage || "An error occurred.",
      "",
      ...args.metaMessages ? [...args.metaMessages, ""] : [],
      ...docsUrl ? [`Docs: ${docsUrl}`] : [],
      ...details ? [`Details: ${details}`] : [],
      ...errorConfig.version ? [`Version: ${errorConfig.version}`] : []
    ].join("\n");
    super(message, args.cause ? { cause: args.cause } : void 0);
    Object.defineProperty(this, "details", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "docsPath", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "metaMessages", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "shortMessage", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "version", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "name", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: "BaseError"
    });
    this.details = details;
    this.docsPath = docsPath;
    this.metaMessages = args.metaMessages;
    this.name = args.name ?? this.name;
    this.shortMessage = shortMessage;
    this.version = version;
  }
  walk(fn) {
    return walk(this, fn);
  }
};
__name(BaseError, "BaseError");
function walk(err, fn) {
  if (fn?.(err))
    return err;
  if (err && typeof err === "object" && "cause" in err && err.cause !== void 0)
    return walk(err.cause, fn);
  return fn ? null : err;
}
__name(walk, "walk");

// node_modules/viem/_esm/errors/encoding.js
var IntegerOutOfRangeError = class extends BaseError {
  constructor({ max, min, signed, size: size3, value }) {
    super(`Number "${value}" is not in safe ${size3 ? `${size3 * 8}-bit ${signed ? "signed" : "unsigned"} ` : ""}integer range ${max ? `(${min} to ${max})` : `(above ${min})`}`, { name: "IntegerOutOfRangeError" });
  }
};
__name(IntegerOutOfRangeError, "IntegerOutOfRangeError");
var SizeOverflowError = class extends BaseError {
  constructor({ givenSize, maxSize }) {
    super(`Size cannot exceed ${maxSize} bytes. Given size: ${givenSize} bytes.`, { name: "SizeOverflowError" });
  }
};
__name(SizeOverflowError, "SizeOverflowError");

// node_modules/viem/_esm/errors/data.js
var SliceOffsetOutOfBoundsError = class extends BaseError {
  constructor({ offset: offset2, position, size: size3 }) {
    super(`Slice ${position === "start" ? "starting" : "ending"} at offset "${offset2}" is out-of-bounds (size: ${size3}).`, { name: "SliceOffsetOutOfBoundsError" });
  }
};
__name(SliceOffsetOutOfBoundsError, "SliceOffsetOutOfBoundsError");
var SizeExceedsPaddingSizeError = class extends BaseError {
  constructor({ size: size3, targetSize, type }) {
    super(`${type.charAt(0).toUpperCase()}${type.slice(1).toLowerCase()} size (${size3}) exceeds padding size (${targetSize}).`, { name: "SizeExceedsPaddingSizeError" });
  }
};
__name(SizeExceedsPaddingSizeError, "SizeExceedsPaddingSizeError");

// node_modules/viem/_esm/utils/data/pad.js
function pad2(hexOrBytes, { dir, size: size3 = 32 } = {}) {
  if (typeof hexOrBytes === "string")
    return padHex(hexOrBytes, { dir, size: size3 });
  return padBytes(hexOrBytes, { dir, size: size3 });
}
__name(pad2, "pad");
function padHex(hex_, { dir, size: size3 = 32 } = {}) {
  if (size3 === null)
    return hex_;
  const hex = hex_.replace("0x", "");
  if (hex.length > size3 * 2)
    throw new SizeExceedsPaddingSizeError({
      size: Math.ceil(hex.length / 2),
      targetSize: size3,
      type: "hex"
    });
  return `0x${hex[dir === "right" ? "padEnd" : "padStart"](size3 * 2, "0")}`;
}
__name(padHex, "padHex");
function padBytes(bytes2, { dir, size: size3 = 32 } = {}) {
  if (size3 === null)
    return bytes2;
  if (bytes2.length > size3)
    throw new SizeExceedsPaddingSizeError({
      size: bytes2.length,
      targetSize: size3,
      type: "bytes"
    });
  const paddedBytes = new Uint8Array(size3);
  for (let i = 0; i < size3; i++) {
    const padEnd = dir === "right";
    paddedBytes[padEnd ? i : size3 - i - 1] = bytes2[padEnd ? i : bytes2.length - i - 1];
  }
  return paddedBytes;
}
__name(padBytes, "padBytes");

// node_modules/viem/_esm/utils/data/isHex.js
function isHex(value, { strict = true } = {}) {
  if (!value)
    return false;
  if (typeof value !== "string")
    return false;
  return strict ? /^0x[0-9a-fA-F]*$/.test(value) : value.startsWith("0x");
}
__name(isHex, "isHex");

// node_modules/viem/_esm/utils/data/size.js
function size2(value) {
  if (isHex(value, { strict: false }))
    return Math.ceil((value.length - 2) / 2);
  return value.length;
}
__name(size2, "size");

// node_modules/viem/_esm/utils/data/trim.js
function trim(hexOrBytes, { dir = "left" } = {}) {
  let data = typeof hexOrBytes === "string" ? hexOrBytes.replace("0x", "") : hexOrBytes;
  let sliceLength = 0;
  for (let i = 0; i < data.length - 1; i++) {
    if (data[dir === "left" ? i : data.length - i - 1].toString() === "0")
      sliceLength++;
    else
      break;
  }
  data = dir === "left" ? data.slice(sliceLength) : data.slice(0, data.length - sliceLength);
  if (typeof hexOrBytes === "string") {
    if (data.length === 1 && dir === "right")
      data = `${data}0`;
    return `0x${data.length % 2 === 1 ? `0${data}` : data}`;
  }
  return data;
}
__name(trim, "trim");

// node_modules/viem/_esm/utils/encoding/toBytes.js
var encoder = /* @__PURE__ */ new TextEncoder();
function toBytes3(value, opts = {}) {
  if (typeof value === "number" || typeof value === "bigint")
    return numberToBytes(value, opts);
  if (typeof value === "boolean")
    return boolToBytes(value, opts);
  if (isHex(value))
    return hexToBytes(value, opts);
  return stringToBytes(value, opts);
}
__name(toBytes3, "toBytes");
function boolToBytes(value, opts = {}) {
  const bytes2 = new Uint8Array(1);
  bytes2[0] = Number(value);
  if (typeof opts.size === "number") {
    assertSize(bytes2, { size: opts.size });
    return pad2(bytes2, { size: opts.size });
  }
  return bytes2;
}
__name(boolToBytes, "boolToBytes");
var charCodeMap = {
  zero: 48,
  nine: 57,
  A: 65,
  F: 70,
  a: 97,
  f: 102
};
function charCodeToBase16(char) {
  if (char >= charCodeMap.zero && char <= charCodeMap.nine)
    return char - charCodeMap.zero;
  if (char >= charCodeMap.A && char <= charCodeMap.F)
    return char - (charCodeMap.A - 10);
  if (char >= charCodeMap.a && char <= charCodeMap.f)
    return char - (charCodeMap.a - 10);
  return void 0;
}
__name(charCodeToBase16, "charCodeToBase16");
function hexToBytes(hex_, opts = {}) {
  let hex = hex_;
  if (opts.size) {
    assertSize(hex, { size: opts.size });
    hex = pad2(hex, { dir: "right", size: opts.size });
  }
  let hexString = hex.slice(2);
  if (hexString.length % 2)
    hexString = `0${hexString}`;
  const length2 = hexString.length / 2;
  const bytes2 = new Uint8Array(length2);
  for (let index2 = 0, j = 0; index2 < length2; index2++) {
    const nibbleLeft = charCodeToBase16(hexString.charCodeAt(j++));
    const nibbleRight = charCodeToBase16(hexString.charCodeAt(j++));
    if (nibbleLeft === void 0 || nibbleRight === void 0) {
      throw new BaseError(`Invalid byte sequence ("${hexString[j - 2]}${hexString[j - 1]}" in "${hexString}").`);
    }
    bytes2[index2] = nibbleLeft * 16 + nibbleRight;
  }
  return bytes2;
}
__name(hexToBytes, "hexToBytes");
function numberToBytes(value, opts) {
  const hex = numberToHex(value, opts);
  return hexToBytes(hex);
}
__name(numberToBytes, "numberToBytes");
function stringToBytes(value, opts = {}) {
  const bytes2 = encoder.encode(value);
  if (typeof opts.size === "number") {
    assertSize(bytes2, { size: opts.size });
    return pad2(bytes2, { dir: "right", size: opts.size });
  }
  return bytes2;
}
__name(stringToBytes, "stringToBytes");

// node_modules/viem/_esm/utils/encoding/fromHex.js
function assertSize(hexOrBytes, { size: size3 }) {
  if (size2(hexOrBytes) > size3)
    throw new SizeOverflowError({
      givenSize: size2(hexOrBytes),
      maxSize: size3
    });
}
__name(assertSize, "assertSize");
function hexToBigInt(hex, opts = {}) {
  const { signed } = opts;
  if (opts.size)
    assertSize(hex, { size: opts.size });
  const value = BigInt(hex);
  if (!signed)
    return value;
  const size3 = Math.ceil((hex.length - 2) / 2);
  const max = (1n << BigInt(size3) * 8n - 1n) - 1n;
  if (value <= max)
    return value;
  return value - BigInt(`0x${"f".padStart(size3 * 2, "f")}`) - 1n;
}
__name(hexToBigInt, "hexToBigInt");
function hexToNumber(hex, opts = {}) {
  const value = hexToBigInt(hex, opts);
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new IntegerOutOfRangeError({
      max: `${Number.MAX_SAFE_INTEGER}`,
      min: `${Number.MIN_SAFE_INTEGER}`,
      signed: opts.signed,
      size: opts.size,
      value: `${value}n`
    });
  return number;
}
__name(hexToNumber, "hexToNumber");

// node_modules/viem/_esm/utils/encoding/toHex.js
var hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_v, i) => i.toString(16).padStart(2, "0"));
function toHex(value, opts = {}) {
  if (typeof value === "number" || typeof value === "bigint")
    return numberToHex(value, opts);
  if (typeof value === "string") {
    return stringToHex(value, opts);
  }
  if (typeof value === "boolean")
    return boolToHex(value, opts);
  return bytesToHex(value, opts);
}
__name(toHex, "toHex");
function boolToHex(value, opts = {}) {
  const hex = `0x${Number(value)}`;
  if (typeof opts.size === "number") {
    assertSize(hex, { size: opts.size });
    return pad2(hex, { size: opts.size });
  }
  return hex;
}
__name(boolToHex, "boolToHex");
function bytesToHex(value, opts = {}) {
  let string = "";
  for (let i = 0; i < value.length; i++) {
    string += hexes[value[i]];
  }
  const hex = `0x${string}`;
  if (typeof opts.size === "number") {
    assertSize(hex, { size: opts.size });
    return pad2(hex, { dir: "right", size: opts.size });
  }
  return hex;
}
__name(bytesToHex, "bytesToHex");
function numberToHex(value_, opts = {}) {
  const { signed, size: size3 } = opts;
  const value = BigInt(value_);
  let maxValue;
  if (size3) {
    if (signed)
      maxValue = (1n << BigInt(size3) * 8n - 1n) - 1n;
    else
      maxValue = 2n ** (BigInt(size3) * 8n) - 1n;
  } else if (typeof value_ === "number") {
    maxValue = BigInt(Number.MAX_SAFE_INTEGER);
  }
  const minValue = typeof maxValue === "bigint" && signed ? -maxValue - 1n : 0;
  if (maxValue && value > maxValue || value < minValue) {
    const suffix = typeof value_ === "bigint" ? "n" : "";
    throw new IntegerOutOfRangeError({
      max: maxValue ? `${maxValue}${suffix}` : void 0,
      min: `${minValue}${suffix}`,
      signed,
      size: size3,
      value: `${value_}${suffix}`
    });
  }
  const hex = `0x${(signed && value < 0 ? (1n << BigInt(size3 * 8)) + BigInt(value) : value).toString(16)}`;
  if (size3)
    return pad2(hex, { size: size3 });
  return hex;
}
__name(numberToHex, "numberToHex");
var encoder2 = /* @__PURE__ */ new TextEncoder();
function stringToHex(value_, opts = {}) {
  const value = encoder2.encode(value_);
  return bytesToHex(value, opts);
}
__name(stringToHex, "stringToHex");

// node_modules/viem/_esm/utils/lru.js
var LruMap = class extends Map {
  constructor(size3) {
    super();
    Object.defineProperty(this, "maxSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    this.maxSize = size3;
  }
  get(key) {
    const value = super.get(key);
    if (super.has(key)) {
      super.delete(key);
      super.set(key, value);
    }
    return value;
  }
  set(key, value) {
    if (super.has(key))
      super.delete(key);
    super.set(key, value);
    if (this.maxSize && this.size > this.maxSize) {
      const firstKey = super.keys().next().value;
      if (firstKey !== void 0)
        super.delete(firstKey);
    }
    return this;
  }
};
__name(LruMap, "LruMap");

// node_modules/viem/node_modules/@noble/hashes/esm/crypto.js
var crypto = typeof globalThis === "object" && "crypto" in globalThis ? globalThis.crypto : void 0;

// node_modules/viem/node_modules/@noble/hashes/esm/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
__name(isBytes, "isBytes");
function anumber(n) {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error("positive integer expected, got " + n);
}
__name(anumber, "anumber");
function abytes(b, ...lengths) {
  if (!isBytes(b))
    throw new Error("Uint8Array expected");
  if (lengths.length > 0 && !lengths.includes(b.length))
    throw new Error("Uint8Array expected of length " + lengths + ", got length=" + b.length);
}
__name(abytes, "abytes");
function ahash(h) {
  if (typeof h !== "function" || typeof h.create !== "function")
    throw new Error("Hash should be wrapped by utils.createHasher");
  anumber(h.outputLen);
  anumber(h.blockLen);
}
__name(ahash, "ahash");
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw new Error("Hash#digest() has already been called");
}
__name(aexists, "aexists");
function aoutput(out, instance) {
  abytes(out);
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error("digestInto() expects output buffer of length at least " + min);
  }
}
__name(aoutput, "aoutput");
function u32(arr) {
  return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
}
__name(u32, "u32");
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
__name(clean, "clean");
function createView2(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
__name(createView2, "createView");
function rotr2(word, shift) {
  return word << 32 - shift | word >>> shift;
}
__name(rotr2, "rotr");
var isLE2 = /* @__PURE__ */ (() => new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68)();
function byteSwap(word) {
  return word << 24 & 4278190080 | word << 8 & 16711680 | word >>> 8 & 65280 | word >>> 24 & 255;
}
__name(byteSwap, "byteSwap");
function byteSwap32(arr) {
  for (let i = 0; i < arr.length; i++) {
    arr[i] = byteSwap(arr[i]);
  }
  return arr;
}
__name(byteSwap32, "byteSwap32");
var swap32IfBE = isLE2 ? (u) => u : byteSwap32;
function utf8ToBytes3(str) {
  if (typeof str !== "string")
    throw new Error("string expected");
  return new Uint8Array(new TextEncoder().encode(str));
}
__name(utf8ToBytes3, "utf8ToBytes");
function toBytes4(data) {
  if (typeof data === "string")
    data = utf8ToBytes3(data);
  abytes(data);
  return data;
}
__name(toBytes4, "toBytes");
function concatBytes(...arrays) {
  let sum = 0;
  for (let i = 0; i < arrays.length; i++) {
    const a = arrays[i];
    abytes(a);
    sum += a.length;
  }
  const res = new Uint8Array(sum);
  for (let i = 0, pad3 = 0; i < arrays.length; i++) {
    const a = arrays[i];
    res.set(a, pad3);
    pad3 += a.length;
  }
  return res;
}
__name(concatBytes, "concatBytes");
var Hash2 = class {
};
__name(Hash2, "Hash");
function createHasher(hashCons) {
  const hashC = /* @__PURE__ */ __name((msg) => hashCons().update(toBytes4(msg)).digest(), "hashC");
  const tmp = hashCons();
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = () => hashCons();
  return hashC;
}
__name(createHasher, "createHasher");
function randomBytes(bytesLength = 32) {
  if (crypto && typeof crypto.getRandomValues === "function") {
    return crypto.getRandomValues(new Uint8Array(bytesLength));
  }
  if (crypto && typeof crypto.randomBytes === "function") {
    return Uint8Array.from(crypto.randomBytes(bytesLength));
  }
  throw new Error("crypto.getRandomValues must be defined");
}
__name(randomBytes, "randomBytes");

// node_modules/viem/node_modules/@noble/hashes/esm/_md.js
function setBigUint642(view, byteOffset, value, isLE3) {
  if (typeof view.setBigUint64 === "function")
    return view.setBigUint64(byteOffset, value, isLE3);
  const _32n2 = BigInt(32);
  const _u32_max = BigInt(4294967295);
  const wh = Number(value >> _32n2 & _u32_max);
  const wl = Number(value & _u32_max);
  const h = isLE3 ? 4 : 0;
  const l = isLE3 ? 0 : 4;
  view.setUint32(byteOffset + h, wh, isLE3);
  view.setUint32(byteOffset + l, wl, isLE3);
}
__name(setBigUint642, "setBigUint64");
function Chi2(a, b, c) {
  return a & b ^ ~a & c;
}
__name(Chi2, "Chi");
function Maj2(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
__name(Maj2, "Maj");
var HashMD = class extends Hash2 {
  constructor(blockLen, outputLen, padOffset, isLE3) {
    super();
    this.finished = false;
    this.length = 0;
    this.pos = 0;
    this.destroyed = false;
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE3;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView2(this.buffer);
  }
  update(data) {
    aexists(this);
    data = toBytes4(data);
    abytes(data);
    const { view, buffer: buffer2, blockLen } = this;
    const len = data.length;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView2 = createView2(data);
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(dataView2, pos);
        continue;
      }
      buffer2.set(data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
      }
    }
    this.length += data.length;
    this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer: buffer2, view, blockLen, isLE: isLE3 } = this;
    let { pos } = this;
    buffer2[pos++] = 128;
    clean(this.buffer.subarray(pos));
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      pos = 0;
    }
    for (let i = pos; i < blockLen; i++)
      buffer2[i] = 0;
    setBigUint642(view, blockLen - 8, BigInt(this.length * 8), isLE3);
    this.process(view, 0);
    const oview = createView2(out);
    const len = this.outputLen;
    if (len % 4)
      throw new Error("_sha2: outputLen should be aligned to 32bit");
    const outLen = len / 4;
    const state = this.get();
    if (outLen > state.length)
      throw new Error("_sha2: outputLen bigger than state");
    for (let i = 0; i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE3);
  }
  digest() {
    const { buffer: buffer2, outputLen } = this;
    this.digestInto(buffer2);
    const res = buffer2.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneInto(to) {
    to || (to = new this.constructor());
    to.set(...this.get());
    const { blockLen, buffer: buffer2, length: length2, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length2;
    to.pos = pos;
    if (length2 % blockLen)
      to.buffer.set(buffer2);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
};
__name(HashMD, "HashMD");
var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);

// node_modules/viem/node_modules/@noble/hashes/esm/_u64.js
var U32_MASK64 = /* @__PURE__ */ BigInt(2 ** 32 - 1);
var _32n = /* @__PURE__ */ BigInt(32);
function fromBig(n, le = false) {
  if (le)
    return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };
  return { h: Number(n >> _32n & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
}
__name(fromBig, "fromBig");
function split2(lst, le = false) {
  const len = lst.length;
  let Ah = new Uint32Array(len);
  let Al = new Uint32Array(len);
  for (let i = 0; i < len; i++) {
    const { h, l } = fromBig(lst[i], le);
    [Ah[i], Al[i]] = [h, l];
  }
  return [Ah, Al];
}
__name(split2, "split");
var rotlSH = /* @__PURE__ */ __name((h, l, s) => h << s | l >>> 32 - s, "rotlSH");
var rotlSL = /* @__PURE__ */ __name((h, l, s) => l << s | h >>> 32 - s, "rotlSL");
var rotlBH = /* @__PURE__ */ __name((h, l, s) => l << s - 32 | h >>> 64 - s, "rotlBH");
var rotlBL = /* @__PURE__ */ __name((h, l, s) => h << s - 32 | l >>> 64 - s, "rotlBL");

// node_modules/viem/node_modules/@noble/hashes/esm/sha2.js
var SHA256_K2 = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var SHA256_W2 = /* @__PURE__ */ new Uint32Array(64);
var SHA2562 = class extends HashMD {
  constructor(outputLen = 32) {
    super(64, outputLen, 8, false);
    this.A = SHA256_IV[0] | 0;
    this.B = SHA256_IV[1] | 0;
    this.C = SHA256_IV[2] | 0;
    this.D = SHA256_IV[3] | 0;
    this.E = SHA256_IV[4] | 0;
    this.F = SHA256_IV[5] | 0;
    this.G = SHA256_IV[6] | 0;
    this.H = SHA256_IV[7] | 0;
  }
  get() {
    const { A, B, C, D, E, F, G, H } = this;
    return [A, B, C, D, E, F, G, H];
  }
  // prettier-ignore
  set(A, B, C, D, E, F, G, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G | 0;
    this.H = H | 0;
  }
  process(view, offset2) {
    for (let i = 0; i < 16; i++, offset2 += 4)
      SHA256_W2[i] = view.getUint32(offset2, false);
    for (let i = 16; i < 64; i++) {
      const W15 = SHA256_W2[i - 15];
      const W2 = SHA256_W2[i - 2];
      const s0 = rotr2(W15, 7) ^ rotr2(W15, 18) ^ W15 >>> 3;
      const s1 = rotr2(W2, 17) ^ rotr2(W2, 19) ^ W2 >>> 10;
      SHA256_W2[i] = s1 + SHA256_W2[i - 7] + s0 + SHA256_W2[i - 16] | 0;
    }
    let { A, B, C, D, E, F, G, H } = this;
    for (let i = 0; i < 64; i++) {
      const sigma1 = rotr2(E, 6) ^ rotr2(E, 11) ^ rotr2(E, 25);
      const T1 = H + sigma1 + Chi2(E, F, G) + SHA256_K2[i] + SHA256_W2[i] | 0;
      const sigma0 = rotr2(A, 2) ^ rotr2(A, 13) ^ rotr2(A, 22);
      const T2 = sigma0 + Maj2(A, B, C) | 0;
      H = G;
      G = F;
      F = E;
      E = D + T1 | 0;
      D = C;
      C = B;
      B = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B = B + this.B | 0;
    C = C + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G = G + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B, C, D, E, F, G, H);
  }
  roundClean() {
    clean(SHA256_W2);
  }
  destroy() {
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean(this.buffer);
  }
};
__name(SHA2562, "SHA256");
var sha2562 = /* @__PURE__ */ createHasher(() => new SHA2562());

// node_modules/viem/node_modules/@noble/hashes/esm/hmac.js
var HMAC = class extends Hash2 {
  constructor(hash, _key) {
    super();
    this.finished = false;
    this.destroyed = false;
    ahash(hash);
    const key = toBytes4(_key);
    this.iHash = hash.create();
    if (typeof this.iHash.update !== "function")
      throw new Error("Expected instance of class which extends utils.Hash");
    this.blockLen = this.iHash.blockLen;
    this.outputLen = this.iHash.outputLen;
    const blockLen = this.blockLen;
    const pad3 = new Uint8Array(blockLen);
    pad3.set(key.length > blockLen ? hash.create().update(key).digest() : key);
    for (let i = 0; i < pad3.length; i++)
      pad3[i] ^= 54;
    this.iHash.update(pad3);
    this.oHash = hash.create();
    for (let i = 0; i < pad3.length; i++)
      pad3[i] ^= 54 ^ 92;
    this.oHash.update(pad3);
    clean(pad3);
  }
  update(buf) {
    aexists(this);
    this.iHash.update(buf);
    return this;
  }
  digestInto(out) {
    aexists(this);
    abytes(out, this.outputLen);
    this.finished = true;
    this.iHash.digestInto(out);
    this.oHash.update(out);
    this.oHash.digestInto(out);
    this.destroy();
  }
  digest() {
    const out = new Uint8Array(this.oHash.outputLen);
    this.digestInto(out);
    return out;
  }
  _cloneInto(to) {
    to || (to = Object.create(Object.getPrototypeOf(this), {}));
    const { oHash, iHash, finished, destroyed, blockLen, outputLen } = this;
    to = to;
    to.finished = finished;
    to.destroyed = destroyed;
    to.blockLen = blockLen;
    to.outputLen = outputLen;
    to.oHash = oHash._cloneInto(to.oHash);
    to.iHash = iHash._cloneInto(to.iHash);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
  destroy() {
    this.destroyed = true;
    this.oHash.destroy();
    this.iHash.destroy();
  }
};
__name(HMAC, "HMAC");
var hmac = /* @__PURE__ */ __name((hash, key, message) => new HMAC(hash, key).update(message).digest(), "hmac");
hmac.create = (hash, key) => new HMAC(hash, key);

// node_modules/viem/node_modules/@noble/curves/esm/abstract/utils.js
var _0n = /* @__PURE__ */ BigInt(0);
var _1n = /* @__PURE__ */ BigInt(1);
function isBytes2(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
__name(isBytes2, "isBytes");
function abytes2(item) {
  if (!isBytes2(item))
    throw new Error("Uint8Array expected");
}
__name(abytes2, "abytes");
function abool(title, value) {
  if (typeof value !== "boolean")
    throw new Error(title + " boolean expected, got " + value);
}
__name(abool, "abool");
function numberToHexUnpadded(num) {
  const hex = num.toString(16);
  return hex.length & 1 ? "0" + hex : hex;
}
__name(numberToHexUnpadded, "numberToHexUnpadded");
function hexToNumber2(hex) {
  if (typeof hex !== "string")
    throw new Error("hex string expected, got " + typeof hex);
  return hex === "" ? _0n : BigInt("0x" + hex);
}
__name(hexToNumber2, "hexToNumber");
var hasHexBuiltin = (
  // @ts-ignore
  typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function"
);
var hexes2 = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
function bytesToHex2(bytes2) {
  abytes2(bytes2);
  if (hasHexBuiltin)
    return bytes2.toHex();
  let hex = "";
  for (let i = 0; i < bytes2.length; i++) {
    hex += hexes2[bytes2[i]];
  }
  return hex;
}
__name(bytesToHex2, "bytesToHex");
var asciis = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
function asciiToBase16(ch) {
  if (ch >= asciis._0 && ch <= asciis._9)
    return ch - asciis._0;
  if (ch >= asciis.A && ch <= asciis.F)
    return ch - (asciis.A - 10);
  if (ch >= asciis.a && ch <= asciis.f)
    return ch - (asciis.a - 10);
  return;
}
__name(asciiToBase16, "asciiToBase16");
function hexToBytes2(hex) {
  if (typeof hex !== "string")
    throw new Error("hex string expected, got " + typeof hex);
  if (hasHexBuiltin)
    return Uint8Array.fromHex(hex);
  const hl = hex.length;
  const al = hl / 2;
  if (hl % 2)
    throw new Error("hex string expected, got unpadded hex of length " + hl);
  const array = new Uint8Array(al);
  for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
    const n1 = asciiToBase16(hex.charCodeAt(hi));
    const n2 = asciiToBase16(hex.charCodeAt(hi + 1));
    if (n1 === void 0 || n2 === void 0) {
      const char = hex[hi] + hex[hi + 1];
      throw new Error('hex string expected, got non-hex character "' + char + '" at index ' + hi);
    }
    array[ai] = n1 * 16 + n2;
  }
  return array;
}
__name(hexToBytes2, "hexToBytes");
function bytesToNumberBE(bytes2) {
  return hexToNumber2(bytesToHex2(bytes2));
}
__name(bytesToNumberBE, "bytesToNumberBE");
function bytesToNumberLE(bytes2) {
  abytes2(bytes2);
  return hexToNumber2(bytesToHex2(Uint8Array.from(bytes2).reverse()));
}
__name(bytesToNumberLE, "bytesToNumberLE");
function numberToBytesBE(n, len) {
  return hexToBytes2(n.toString(16).padStart(len * 2, "0"));
}
__name(numberToBytesBE, "numberToBytesBE");
function numberToBytesLE(n, len) {
  return numberToBytesBE(n, len).reverse();
}
__name(numberToBytesLE, "numberToBytesLE");
function ensureBytes(title, hex, expectedLength) {
  let res;
  if (typeof hex === "string") {
    try {
      res = hexToBytes2(hex);
    } catch (e) {
      throw new Error(title + " must be hex string or Uint8Array, cause: " + e);
    }
  } else if (isBytes2(hex)) {
    res = Uint8Array.from(hex);
  } else {
    throw new Error(title + " must be hex string or Uint8Array");
  }
  const len = res.length;
  if (typeof expectedLength === "number" && len !== expectedLength)
    throw new Error(title + " of length " + expectedLength + " expected, got " + len);
  return res;
}
__name(ensureBytes, "ensureBytes");
function concatBytes2(...arrays) {
  let sum = 0;
  for (let i = 0; i < arrays.length; i++) {
    const a = arrays[i];
    abytes2(a);
    sum += a.length;
  }
  const res = new Uint8Array(sum);
  for (let i = 0, pad3 = 0; i < arrays.length; i++) {
    const a = arrays[i];
    res.set(a, pad3);
    pad3 += a.length;
  }
  return res;
}
__name(concatBytes2, "concatBytes");
var isPosBig = /* @__PURE__ */ __name((n) => typeof n === "bigint" && _0n <= n, "isPosBig");
function inRange(n, min, max) {
  return isPosBig(n) && isPosBig(min) && isPosBig(max) && min <= n && n < max;
}
__name(inRange, "inRange");
function aInRange(title, n, min, max) {
  if (!inRange(n, min, max))
    throw new Error("expected valid " + title + ": " + min + " <= n < " + max + ", got " + n);
}
__name(aInRange, "aInRange");
function bitLen(n) {
  let len;
  for (len = 0; n > _0n; n >>= _1n, len += 1)
    ;
  return len;
}
__name(bitLen, "bitLen");
var bitMask = /* @__PURE__ */ __name((n) => (_1n << BigInt(n)) - _1n, "bitMask");
var u8n = /* @__PURE__ */ __name((len) => new Uint8Array(len), "u8n");
var u8fr = /* @__PURE__ */ __name((arr) => Uint8Array.from(arr), "u8fr");
function createHmacDrbg(hashLen, qByteLen, hmacFn) {
  if (typeof hashLen !== "number" || hashLen < 2)
    throw new Error("hashLen must be a number");
  if (typeof qByteLen !== "number" || qByteLen < 2)
    throw new Error("qByteLen must be a number");
  if (typeof hmacFn !== "function")
    throw new Error("hmacFn must be a function");
  let v = u8n(hashLen);
  let k = u8n(hashLen);
  let i = 0;
  const reset = /* @__PURE__ */ __name(() => {
    v.fill(1);
    k.fill(0);
    i = 0;
  }, "reset");
  const h = /* @__PURE__ */ __name((...b) => hmacFn(k, v, ...b), "h");
  const reseed = /* @__PURE__ */ __name((seed = u8n(0)) => {
    k = h(u8fr([0]), seed);
    v = h();
    if (seed.length === 0)
      return;
    k = h(u8fr([1]), seed);
    v = h();
  }, "reseed");
  const gen2 = /* @__PURE__ */ __name(() => {
    if (i++ >= 1e3)
      throw new Error("drbg: tried 1000 values");
    let len = 0;
    const out = [];
    while (len < qByteLen) {
      v = h();
      const sl = v.slice();
      out.push(sl);
      len += v.length;
    }
    return concatBytes2(...out);
  }, "gen");
  const genUntil = /* @__PURE__ */ __name((seed, pred) => {
    reset();
    reseed(seed);
    let res = void 0;
    while (!(res = pred(gen2())))
      reseed();
    reset();
    return res;
  }, "genUntil");
  return genUntil;
}
__name(createHmacDrbg, "createHmacDrbg");
var validatorFns = {
  bigint: (val) => typeof val === "bigint",
  function: (val) => typeof val === "function",
  boolean: (val) => typeof val === "boolean",
  string: (val) => typeof val === "string",
  stringOrUint8Array: (val) => typeof val === "string" || isBytes2(val),
  isSafeInteger: (val) => Number.isSafeInteger(val),
  array: (val) => Array.isArray(val),
  field: (val, object) => object.Fp.isValid(val),
  hash: (val) => typeof val === "function" && Number.isSafeInteger(val.outputLen)
};
function validateObject(object, validators, optValidators = {}) {
  const checkField = /* @__PURE__ */ __name((fieldName, type, isOptional) => {
    const checkVal = validatorFns[type];
    if (typeof checkVal !== "function")
      throw new Error("invalid validator function");
    const val = object[fieldName];
    if (isOptional && val === void 0)
      return;
    if (!checkVal(val, object)) {
      throw new Error("param " + String(fieldName) + " is invalid. Expected " + type + ", got " + val);
    }
  }, "checkField");
  for (const [fieldName, type] of Object.entries(validators))
    checkField(fieldName, type, false);
  for (const [fieldName, type] of Object.entries(optValidators))
    checkField(fieldName, type, true);
  return object;
}
__name(validateObject, "validateObject");
function memoized(fn) {
  const map = /* @__PURE__ */ new WeakMap();
  return (arg, ...args) => {
    const val = map.get(arg);
    if (val !== void 0)
      return val;
    const computed = fn(arg, ...args);
    map.set(arg, computed);
    return computed;
  };
}
__name(memoized, "memoized");

// node_modules/viem/node_modules/@noble/curves/esm/abstract/modular.js
var _0n2 = BigInt(0);
var _1n2 = BigInt(1);
var _2n = /* @__PURE__ */ BigInt(2);
var _3n = /* @__PURE__ */ BigInt(3);
var _4n = /* @__PURE__ */ BigInt(4);
var _5n = /* @__PURE__ */ BigInt(5);
var _8n = /* @__PURE__ */ BigInt(8);
function mod(a, b) {
  const result = a % b;
  return result >= _0n2 ? result : b + result;
}
__name(mod, "mod");
function pow22(x, power, modulo) {
  let res = x;
  while (power-- > _0n2) {
    res *= res;
    res %= modulo;
  }
  return res;
}
__name(pow22, "pow2");
function invert(number, modulo) {
  if (number === _0n2)
    throw new Error("invert: expected non-zero number");
  if (modulo <= _0n2)
    throw new Error("invert: expected positive modulus, got " + modulo);
  let a = mod(number, modulo);
  let b = modulo;
  let x = _0n2, y = _1n2, u = _1n2, v = _0n2;
  while (a !== _0n2) {
    const q = b / a;
    const r = b % a;
    const m = x - u * q;
    const n = y - v * q;
    b = a, a = r, x = u, y = v, u = m, v = n;
  }
  const gcd = b;
  if (gcd !== _1n2)
    throw new Error("invert: does not exist");
  return mod(x, modulo);
}
__name(invert, "invert");
function sqrt3mod4(Fp, n) {
  const p1div4 = (Fp.ORDER + _1n2) / _4n;
  const root2 = Fp.pow(n, p1div4);
  if (!Fp.eql(Fp.sqr(root2), n))
    throw new Error("Cannot find square root");
  return root2;
}
__name(sqrt3mod4, "sqrt3mod4");
function sqrt5mod8(Fp, n) {
  const p5div8 = (Fp.ORDER - _5n) / _8n;
  const n2 = Fp.mul(n, _2n);
  const v = Fp.pow(n2, p5div8);
  const nv = Fp.mul(n, v);
  const i = Fp.mul(Fp.mul(nv, _2n), v);
  const root2 = Fp.mul(nv, Fp.sub(i, Fp.ONE));
  if (!Fp.eql(Fp.sqr(root2), n))
    throw new Error("Cannot find square root");
  return root2;
}
__name(sqrt5mod8, "sqrt5mod8");
function tonelliShanks(P) {
  if (P < BigInt(3))
    throw new Error("sqrt is not defined for small field");
  let Q = P - _1n2;
  let S = 0;
  while (Q % _2n === _0n2) {
    Q /= _2n;
    S++;
  }
  let Z = _2n;
  const _Fp = Field(P);
  while (FpLegendre(_Fp, Z) === 1) {
    if (Z++ > 1e3)
      throw new Error("Cannot find square root: probably non-prime P");
  }
  if (S === 1)
    return sqrt3mod4;
  let cc = _Fp.pow(Z, Q);
  const Q1div2 = (Q + _1n2) / _2n;
  return /* @__PURE__ */ __name(function tonelliSlow(Fp, n) {
    if (Fp.is0(n))
      return n;
    if (FpLegendre(Fp, n) !== 1)
      throw new Error("Cannot find square root");
    let M = S;
    let c = Fp.mul(Fp.ONE, cc);
    let t = Fp.pow(n, Q);
    let R = Fp.pow(n, Q1div2);
    while (!Fp.eql(t, Fp.ONE)) {
      if (Fp.is0(t))
        return Fp.ZERO;
      let i = 1;
      let t_tmp = Fp.sqr(t);
      while (!Fp.eql(t_tmp, Fp.ONE)) {
        i++;
        t_tmp = Fp.sqr(t_tmp);
        if (i === M)
          throw new Error("Cannot find square root");
      }
      const exponent = _1n2 << BigInt(M - i - 1);
      const b = Fp.pow(c, exponent);
      M = i;
      c = Fp.sqr(b);
      t = Fp.mul(t, c);
      R = Fp.mul(R, b);
    }
    return R;
  }, "tonelliSlow");
}
__name(tonelliShanks, "tonelliShanks");
function FpSqrt(P) {
  if (P % _4n === _3n)
    return sqrt3mod4;
  if (P % _8n === _5n)
    return sqrt5mod8;
  return tonelliShanks(P);
}
__name(FpSqrt, "FpSqrt");
var FIELD_FIELDS = [
  "create",
  "isValid",
  "is0",
  "neg",
  "inv",
  "sqrt",
  "sqr",
  "eql",
  "add",
  "sub",
  "mul",
  "pow",
  "div",
  "addN",
  "subN",
  "mulN",
  "sqrN"
];
function validateField(field) {
  const initial = {
    ORDER: "bigint",
    MASK: "bigint",
    BYTES: "isSafeInteger",
    BITS: "isSafeInteger"
  };
  const opts = FIELD_FIELDS.reduce((map, val) => {
    map[val] = "function";
    return map;
  }, initial);
  return validateObject(field, opts);
}
__name(validateField, "validateField");
function FpPow(Fp, num, power) {
  if (power < _0n2)
    throw new Error("invalid exponent, negatives unsupported");
  if (power === _0n2)
    return Fp.ONE;
  if (power === _1n2)
    return num;
  let p = Fp.ONE;
  let d = num;
  while (power > _0n2) {
    if (power & _1n2)
      p = Fp.mul(p, d);
    d = Fp.sqr(d);
    power >>= _1n2;
  }
  return p;
}
__name(FpPow, "FpPow");
function FpInvertBatch(Fp, nums, passZero = false) {
  const inverted = new Array(nums.length).fill(passZero ? Fp.ZERO : void 0);
  const multipliedAcc = nums.reduce((acc, num, i) => {
    if (Fp.is0(num))
      return acc;
    inverted[i] = acc;
    return Fp.mul(acc, num);
  }, Fp.ONE);
  const invertedAcc = Fp.inv(multipliedAcc);
  nums.reduceRight((acc, num, i) => {
    if (Fp.is0(num))
      return acc;
    inverted[i] = Fp.mul(acc, inverted[i]);
    return Fp.mul(acc, num);
  }, invertedAcc);
  return inverted;
}
__name(FpInvertBatch, "FpInvertBatch");
function FpLegendre(Fp, n) {
  const p1mod2 = (Fp.ORDER - _1n2) / _2n;
  const powered = Fp.pow(n, p1mod2);
  const yes = Fp.eql(powered, Fp.ONE);
  const zero = Fp.eql(powered, Fp.ZERO);
  const no = Fp.eql(powered, Fp.neg(Fp.ONE));
  if (!yes && !zero && !no)
    throw new Error("invalid Legendre symbol result");
  return yes ? 1 : zero ? 0 : -1;
}
__name(FpLegendre, "FpLegendre");
function nLength(n, nBitLength) {
  if (nBitLength !== void 0)
    anumber(nBitLength);
  const _nBitLength = nBitLength !== void 0 ? nBitLength : n.toString(2).length;
  const nByteLength = Math.ceil(_nBitLength / 8);
  return { nBitLength: _nBitLength, nByteLength };
}
__name(nLength, "nLength");
function Field(ORDER, bitLen2, isLE3 = false, redef = {}) {
  if (ORDER <= _0n2)
    throw new Error("invalid field: expected ORDER > 0, got " + ORDER);
  const { nBitLength: BITS, nByteLength: BYTES } = nLength(ORDER, bitLen2);
  if (BYTES > 2048)
    throw new Error("invalid field: expected ORDER of <= 2048 bytes");
  let sqrtP;
  const f = Object.freeze({
    ORDER,
    isLE: isLE3,
    BITS,
    BYTES,
    MASK: bitMask(BITS),
    ZERO: _0n2,
    ONE: _1n2,
    create: (num) => mod(num, ORDER),
    isValid: (num) => {
      if (typeof num !== "bigint")
        throw new Error("invalid field element: expected bigint, got " + typeof num);
      return _0n2 <= num && num < ORDER;
    },
    is0: (num) => num === _0n2,
    isOdd: (num) => (num & _1n2) === _1n2,
    neg: (num) => mod(-num, ORDER),
    eql: (lhs, rhs) => lhs === rhs,
    sqr: (num) => mod(num * num, ORDER),
    add: (lhs, rhs) => mod(lhs + rhs, ORDER),
    sub: (lhs, rhs) => mod(lhs - rhs, ORDER),
    mul: (lhs, rhs) => mod(lhs * rhs, ORDER),
    pow: (num, power) => FpPow(f, num, power),
    div: (lhs, rhs) => mod(lhs * invert(rhs, ORDER), ORDER),
    // Same as above, but doesn't normalize
    sqrN: (num) => num * num,
    addN: (lhs, rhs) => lhs + rhs,
    subN: (lhs, rhs) => lhs - rhs,
    mulN: (lhs, rhs) => lhs * rhs,
    inv: (num) => invert(num, ORDER),
    sqrt: redef.sqrt || ((n) => {
      if (!sqrtP)
        sqrtP = FpSqrt(ORDER);
      return sqrtP(f, n);
    }),
    toBytes: (num) => isLE3 ? numberToBytesLE(num, BYTES) : numberToBytesBE(num, BYTES),
    fromBytes: (bytes2) => {
      if (bytes2.length !== BYTES)
        throw new Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes2.length);
      return isLE3 ? bytesToNumberLE(bytes2) : bytesToNumberBE(bytes2);
    },
    // TODO: we don't need it here, move out to separate fn
    invertBatch: (lst) => FpInvertBatch(f, lst),
    // We can't move this out because Fp6, Fp12 implement it
    // and it's unclear what to return in there.
    cmov: (a, b, c) => c ? b : a
  });
  return Object.freeze(f);
}
__name(Field, "Field");
function getFieldBytesLength(fieldOrder) {
  if (typeof fieldOrder !== "bigint")
    throw new Error("field order must be bigint");
  const bitLength = fieldOrder.toString(2).length;
  return Math.ceil(bitLength / 8);
}
__name(getFieldBytesLength, "getFieldBytesLength");
function getMinHashLength(fieldOrder) {
  const length2 = getFieldBytesLength(fieldOrder);
  return length2 + Math.ceil(length2 / 2);
}
__name(getMinHashLength, "getMinHashLength");
function mapHashToField(key, fieldOrder, isLE3 = false) {
  const len = key.length;
  const fieldLen = getFieldBytesLength(fieldOrder);
  const minLen = getMinHashLength(fieldOrder);
  if (len < 16 || len < minLen || len > 1024)
    throw new Error("expected " + minLen + "-1024 bytes of input, got " + len);
  const num = isLE3 ? bytesToNumberLE(key) : bytesToNumberBE(key);
  const reduced = mod(num, fieldOrder - _1n2) + _1n2;
  return isLE3 ? numberToBytesLE(reduced, fieldLen) : numberToBytesBE(reduced, fieldLen);
}
__name(mapHashToField, "mapHashToField");

// node_modules/viem/node_modules/@noble/curves/esm/abstract/curve.js
var _0n3 = BigInt(0);
var _1n3 = BigInt(1);
function constTimeNegate(condition, item) {
  const neg = item.negate();
  return condition ? neg : item;
}
__name(constTimeNegate, "constTimeNegate");
function validateW(W, bits) {
  if (!Number.isSafeInteger(W) || W <= 0 || W > bits)
    throw new Error("invalid window size, expected [1.." + bits + "], got W=" + W);
}
__name(validateW, "validateW");
function calcWOpts(W, scalarBits) {
  validateW(W, scalarBits);
  const windows = Math.ceil(scalarBits / W) + 1;
  const windowSize = 2 ** (W - 1);
  const maxNumber = 2 ** W;
  const mask = bitMask(W);
  const shiftBy = BigInt(W);
  return { windows, windowSize, mask, maxNumber, shiftBy };
}
__name(calcWOpts, "calcWOpts");
function calcOffsets(n, window, wOpts) {
  const { windowSize, mask, maxNumber, shiftBy } = wOpts;
  let wbits = Number(n & mask);
  let nextN = n >> shiftBy;
  if (wbits > windowSize) {
    wbits -= maxNumber;
    nextN += _1n3;
  }
  const offsetStart = window * windowSize;
  const offset2 = offsetStart + Math.abs(wbits) - 1;
  const isZero = wbits === 0;
  const isNeg = wbits < 0;
  const isNegF = window % 2 !== 0;
  const offsetF = offsetStart;
  return { nextN, offset: offset2, isZero, isNeg, isNegF, offsetF };
}
__name(calcOffsets, "calcOffsets");
function validateMSMPoints(points, c) {
  if (!Array.isArray(points))
    throw new Error("array expected");
  points.forEach((p, i) => {
    if (!(p instanceof c))
      throw new Error("invalid point at index " + i);
  });
}
__name(validateMSMPoints, "validateMSMPoints");
function validateMSMScalars(scalars, field) {
  if (!Array.isArray(scalars))
    throw new Error("array of scalars expected");
  scalars.forEach((s, i) => {
    if (!field.isValid(s))
      throw new Error("invalid scalar at index " + i);
  });
}
__name(validateMSMScalars, "validateMSMScalars");
var pointPrecomputes = /* @__PURE__ */ new WeakMap();
var pointWindowSizes = /* @__PURE__ */ new WeakMap();
function getW(P) {
  return pointWindowSizes.get(P) || 1;
}
__name(getW, "getW");
function wNAF(c, bits) {
  return {
    constTimeNegate,
    hasPrecomputes(elm) {
      return getW(elm) !== 1;
    },
    // non-const time multiplication ladder
    unsafeLadder(elm, n, p = c.ZERO) {
      let d = elm;
      while (n > _0n3) {
        if (n & _1n3)
          p = p.add(d);
        d = d.double();
        n >>= _1n3;
      }
      return p;
    },
    /**
     * Creates a wNAF precomputation window. Used for caching.
     * Default window size is set by `utils.precompute()` and is equal to 8.
     * Number of precomputed points depends on the curve size:
     * 2^(𝑊−1) * (Math.ceil(𝑛 / 𝑊) + 1), where:
     * - 𝑊 is the window size
     * - 𝑛 is the bitlength of the curve order.
     * For a 256-bit curve and window size 8, the number of precomputed points is 128 * 33 = 4224.
     * @param elm Point instance
     * @param W window size
     * @returns precomputed point tables flattened to a single array
     */
    precomputeWindow(elm, W) {
      const { windows, windowSize } = calcWOpts(W, bits);
      const points = [];
      let p = elm;
      let base2 = p;
      for (let window = 0; window < windows; window++) {
        base2 = p;
        points.push(base2);
        for (let i = 1; i < windowSize; i++) {
          base2 = base2.add(p);
          points.push(base2);
        }
        p = base2.double();
      }
      return points;
    },
    /**
     * Implements ec multiplication using precomputed tables and w-ary non-adjacent form.
     * @param W window size
     * @param precomputes precomputed tables
     * @param n scalar (we don't check here, but should be less than curve order)
     * @returns real and fake (for const-time) points
     */
    wNAF(W, precomputes, n) {
      let p = c.ZERO;
      let f = c.BASE;
      const wo = calcWOpts(W, bits);
      for (let window = 0; window < wo.windows; window++) {
        const { nextN, offset: offset2, isZero, isNeg, isNegF, offsetF } = calcOffsets(n, window, wo);
        n = nextN;
        if (isZero) {
          f = f.add(constTimeNegate(isNegF, precomputes[offsetF]));
        } else {
          p = p.add(constTimeNegate(isNeg, precomputes[offset2]));
        }
      }
      return { p, f };
    },
    /**
     * Implements ec unsafe (non const-time) multiplication using precomputed tables and w-ary non-adjacent form.
     * @param W window size
     * @param precomputes precomputed tables
     * @param n scalar (we don't check here, but should be less than curve order)
     * @param acc accumulator point to add result of multiplication
     * @returns point
     */
    wNAFUnsafe(W, precomputes, n, acc = c.ZERO) {
      const wo = calcWOpts(W, bits);
      for (let window = 0; window < wo.windows; window++) {
        if (n === _0n3)
          break;
        const { nextN, offset: offset2, isZero, isNeg } = calcOffsets(n, window, wo);
        n = nextN;
        if (isZero) {
          continue;
        } else {
          const item = precomputes[offset2];
          acc = acc.add(isNeg ? item.negate() : item);
        }
      }
      return acc;
    },
    getPrecomputes(W, P, transform) {
      let comp = pointPrecomputes.get(P);
      if (!comp) {
        comp = this.precomputeWindow(P, W);
        if (W !== 1)
          pointPrecomputes.set(P, transform(comp));
      }
      return comp;
    },
    wNAFCached(P, n, transform) {
      const W = getW(P);
      return this.wNAF(W, this.getPrecomputes(W, P, transform), n);
    },
    wNAFCachedUnsafe(P, n, transform, prev) {
      const W = getW(P);
      if (W === 1)
        return this.unsafeLadder(P, n, prev);
      return this.wNAFUnsafe(W, this.getPrecomputes(W, P, transform), n, prev);
    },
    // We calculate precomputes for elliptic curve point multiplication
    // using windowed method. This specifies window size and
    // stores precomputed values. Usually only base point would be precomputed.
    setWindowSize(P, W) {
      validateW(W, bits);
      pointWindowSizes.set(P, W);
      pointPrecomputes.delete(P);
    }
  };
}
__name(wNAF, "wNAF");
function pippenger(c, fieldN, points, scalars) {
  validateMSMPoints(points, c);
  validateMSMScalars(scalars, fieldN);
  const plength = points.length;
  const slength = scalars.length;
  if (plength !== slength)
    throw new Error("arrays of points and scalars must have equal length");
  const zero = c.ZERO;
  const wbits = bitLen(BigInt(plength));
  let windowSize = 1;
  if (wbits > 12)
    windowSize = wbits - 3;
  else if (wbits > 4)
    windowSize = wbits - 2;
  else if (wbits > 0)
    windowSize = 2;
  const MASK = bitMask(windowSize);
  const buckets = new Array(Number(MASK) + 1).fill(zero);
  const lastBits = Math.floor((fieldN.BITS - 1) / windowSize) * windowSize;
  let sum = zero;
  for (let i = lastBits; i >= 0; i -= windowSize) {
    buckets.fill(zero);
    for (let j = 0; j < slength; j++) {
      const scalar = scalars[j];
      const wbits2 = Number(scalar >> BigInt(i) & MASK);
      buckets[wbits2] = buckets[wbits2].add(points[j]);
    }
    let resI = zero;
    for (let j = buckets.length - 1, sumI = zero; j > 0; j--) {
      sumI = sumI.add(buckets[j]);
      resI = resI.add(sumI);
    }
    sum = sum.add(resI);
    if (i !== 0)
      for (let j = 0; j < windowSize; j++)
        sum = sum.double();
  }
  return sum;
}
__name(pippenger, "pippenger");
function validateBasic(curve) {
  validateField(curve.Fp);
  validateObject(curve, {
    n: "bigint",
    h: "bigint",
    Gx: "field",
    Gy: "field"
  }, {
    nBitLength: "isSafeInteger",
    nByteLength: "isSafeInteger"
  });
  return Object.freeze({
    ...nLength(curve.n, curve.nBitLength),
    ...curve,
    ...{ p: curve.Fp.ORDER }
  });
}
__name(validateBasic, "validateBasic");

// node_modules/viem/node_modules/@noble/curves/esm/abstract/weierstrass.js
function validateSigVerOpts(opts) {
  if (opts.lowS !== void 0)
    abool("lowS", opts.lowS);
  if (opts.prehash !== void 0)
    abool("prehash", opts.prehash);
}
__name(validateSigVerOpts, "validateSigVerOpts");
function validatePointOpts(curve) {
  const opts = validateBasic(curve);
  validateObject(opts, {
    a: "field",
    b: "field"
  }, {
    allowInfinityPoint: "boolean",
    allowedPrivateKeyLengths: "array",
    clearCofactor: "function",
    fromBytes: "function",
    isTorsionFree: "function",
    toBytes: "function",
    wrapPrivateKey: "boolean"
  });
  const { endo, Fp, a } = opts;
  if (endo) {
    if (!Fp.eql(a, Fp.ZERO)) {
      throw new Error("invalid endo: CURVE.a must be 0");
    }
    if (typeof endo !== "object" || typeof endo.beta !== "bigint" || typeof endo.splitScalar !== "function") {
      throw new Error('invalid endo: expected "beta": bigint and "splitScalar": function');
    }
  }
  return Object.freeze({ ...opts });
}
__name(validatePointOpts, "validatePointOpts");
var DERErr = class extends Error {
  constructor(m = "") {
    super(m);
  }
};
__name(DERErr, "DERErr");
var DER = {
  // asn.1 DER encoding utils
  Err: DERErr,
  // Basic building block is TLV (Tag-Length-Value)
  _tlv: {
    encode: (tag, data) => {
      const { Err: E } = DER;
      if (tag < 0 || tag > 256)
        throw new E("tlv.encode: wrong tag");
      if (data.length & 1)
        throw new E("tlv.encode: unpadded data");
      const dataLen = data.length / 2;
      const len = numberToHexUnpadded(dataLen);
      if (len.length / 2 & 128)
        throw new E("tlv.encode: long form length too big");
      const lenLen = dataLen > 127 ? numberToHexUnpadded(len.length / 2 | 128) : "";
      const t = numberToHexUnpadded(tag);
      return t + lenLen + len + data;
    },
    // v - value, l - left bytes (unparsed)
    decode(tag, data) {
      const { Err: E } = DER;
      let pos = 0;
      if (tag < 0 || tag > 256)
        throw new E("tlv.encode: wrong tag");
      if (data.length < 2 || data[pos++] !== tag)
        throw new E("tlv.decode: wrong tlv");
      const first = data[pos++];
      const isLong = !!(first & 128);
      let length2 = 0;
      if (!isLong)
        length2 = first;
      else {
        const lenLen = first & 127;
        if (!lenLen)
          throw new E("tlv.decode(long): indefinite length not supported");
        if (lenLen > 4)
          throw new E("tlv.decode(long): byte length is too big");
        const lengthBytes = data.subarray(pos, pos + lenLen);
        if (lengthBytes.length !== lenLen)
          throw new E("tlv.decode: length bytes not complete");
        if (lengthBytes[0] === 0)
          throw new E("tlv.decode(long): zero leftmost byte");
        for (const b of lengthBytes)
          length2 = length2 << 8 | b;
        pos += lenLen;
        if (length2 < 128)
          throw new E("tlv.decode(long): not minimal encoding");
      }
      const v = data.subarray(pos, pos + length2);
      if (v.length !== length2)
        throw new E("tlv.decode: wrong value length");
      return { v, l: data.subarray(pos + length2) };
    }
  },
  // https://crypto.stackexchange.com/a/57734 Leftmost bit of first byte is 'negative' flag,
  // since we always use positive integers here. It must always be empty:
  // - add zero byte if exists
  // - if next byte doesn't have a flag, leading zero is not allowed (minimal encoding)
  _int: {
    encode(num) {
      const { Err: E } = DER;
      if (num < _0n4)
        throw new E("integer: negative integers are not allowed");
      let hex = numberToHexUnpadded(num);
      if (Number.parseInt(hex[0], 16) & 8)
        hex = "00" + hex;
      if (hex.length & 1)
        throw new E("unexpected DER parsing assertion: unpadded hex");
      return hex;
    },
    decode(data) {
      const { Err: E } = DER;
      if (data[0] & 128)
        throw new E("invalid signature integer: negative");
      if (data[0] === 0 && !(data[1] & 128))
        throw new E("invalid signature integer: unnecessary leading zero");
      return bytesToNumberBE(data);
    }
  },
  toSig(hex) {
    const { Err: E, _int: int, _tlv: tlv } = DER;
    const data = ensureBytes("signature", hex);
    const { v: seqBytes, l: seqLeftBytes } = tlv.decode(48, data);
    if (seqLeftBytes.length)
      throw new E("invalid signature: left bytes after parsing");
    const { v: rBytes, l: rLeftBytes } = tlv.decode(2, seqBytes);
    const { v: sBytes, l: sLeftBytes } = tlv.decode(2, rLeftBytes);
    if (sLeftBytes.length)
      throw new E("invalid signature: left bytes after parsing");
    return { r: int.decode(rBytes), s: int.decode(sBytes) };
  },
  hexFromSig(sig) {
    const { _tlv: tlv, _int: int } = DER;
    const rs = tlv.encode(2, int.encode(sig.r));
    const ss = tlv.encode(2, int.encode(sig.s));
    const seq = rs + ss;
    return tlv.encode(48, seq);
  }
};
function numToSizedHex(num, size3) {
  return bytesToHex2(numberToBytesBE(num, size3));
}
__name(numToSizedHex, "numToSizedHex");
var _0n4 = BigInt(0);
var _1n4 = BigInt(1);
var _2n2 = BigInt(2);
var _3n2 = BigInt(3);
var _4n2 = BigInt(4);
function weierstrassPoints(opts) {
  const CURVE = validatePointOpts(opts);
  const { Fp } = CURVE;
  const Fn = Field(CURVE.n, CURVE.nBitLength);
  const toBytes5 = CURVE.toBytes || ((_c, point, _isCompressed) => {
    const a = point.toAffine();
    return concatBytes2(Uint8Array.from([4]), Fp.toBytes(a.x), Fp.toBytes(a.y));
  });
  const fromBytes2 = CURVE.fromBytes || ((bytes2) => {
    const tail = bytes2.subarray(1);
    const x = Fp.fromBytes(tail.subarray(0, Fp.BYTES));
    const y = Fp.fromBytes(tail.subarray(Fp.BYTES, 2 * Fp.BYTES));
    return { x, y };
  });
  function weierstrassEquation(x) {
    const { a, b } = CURVE;
    const x2 = Fp.sqr(x);
    const x3 = Fp.mul(x2, x);
    return Fp.add(Fp.add(x3, Fp.mul(x, a)), b);
  }
  __name(weierstrassEquation, "weierstrassEquation");
  function isValidXY(x, y) {
    const left = Fp.sqr(y);
    const right = weierstrassEquation(x);
    return Fp.eql(left, right);
  }
  __name(isValidXY, "isValidXY");
  if (!isValidXY(CURVE.Gx, CURVE.Gy))
    throw new Error("bad curve params: generator point");
  const _4a3 = Fp.mul(Fp.pow(CURVE.a, _3n2), _4n2);
  const _27b2 = Fp.mul(Fp.sqr(CURVE.b), BigInt(27));
  if (Fp.is0(Fp.add(_4a3, _27b2)))
    throw new Error("bad curve params: a or b");
  function isWithinCurveOrder(num) {
    return inRange(num, _1n4, CURVE.n);
  }
  __name(isWithinCurveOrder, "isWithinCurveOrder");
  function normPrivateKeyToScalar(key) {
    const { allowedPrivateKeyLengths: lengths, nByteLength, wrapPrivateKey, n: N } = CURVE;
    if (lengths && typeof key !== "bigint") {
      if (isBytes2(key))
        key = bytesToHex2(key);
      if (typeof key !== "string" || !lengths.includes(key.length))
        throw new Error("invalid private key");
      key = key.padStart(nByteLength * 2, "0");
    }
    let num;
    try {
      num = typeof key === "bigint" ? key : bytesToNumberBE(ensureBytes("private key", key, nByteLength));
    } catch (error) {
      throw new Error("invalid private key, expected hex or " + nByteLength + " bytes, got " + typeof key);
    }
    if (wrapPrivateKey)
      num = mod(num, N);
    aInRange("private key", num, _1n4, N);
    return num;
  }
  __name(normPrivateKeyToScalar, "normPrivateKeyToScalar");
  function aprjpoint(other) {
    if (!(other instanceof Point))
      throw new Error("ProjectivePoint expected");
  }
  __name(aprjpoint, "aprjpoint");
  const toAffineMemo = memoized((p, iz) => {
    const { px: x, py: y, pz: z } = p;
    if (Fp.eql(z, Fp.ONE))
      return { x, y };
    const is0 = p.is0();
    if (iz == null)
      iz = is0 ? Fp.ONE : Fp.inv(z);
    const ax = Fp.mul(x, iz);
    const ay = Fp.mul(y, iz);
    const zz = Fp.mul(z, iz);
    if (is0)
      return { x: Fp.ZERO, y: Fp.ZERO };
    if (!Fp.eql(zz, Fp.ONE))
      throw new Error("invZ was invalid");
    return { x: ax, y: ay };
  });
  const assertValidMemo = memoized((p) => {
    if (p.is0()) {
      if (CURVE.allowInfinityPoint && !Fp.is0(p.py))
        return;
      throw new Error("bad point: ZERO");
    }
    const { x, y } = p.toAffine();
    if (!Fp.isValid(x) || !Fp.isValid(y))
      throw new Error("bad point: x or y not FE");
    if (!isValidXY(x, y))
      throw new Error("bad point: equation left != right");
    if (!p.isTorsionFree())
      throw new Error("bad point: not in prime-order subgroup");
    return true;
  });
  class Point {
    constructor(px, py, pz) {
      if (px == null || !Fp.isValid(px))
        throw new Error("x required");
      if (py == null || !Fp.isValid(py) || Fp.is0(py))
        throw new Error("y required");
      if (pz == null || !Fp.isValid(pz))
        throw new Error("z required");
      this.px = px;
      this.py = py;
      this.pz = pz;
      Object.freeze(this);
    }
    // Does not validate if the point is on-curve.
    // Use fromHex instead, or call assertValidity() later.
    static fromAffine(p) {
      const { x, y } = p || {};
      if (!p || !Fp.isValid(x) || !Fp.isValid(y))
        throw new Error("invalid affine point");
      if (p instanceof Point)
        throw new Error("projective point not allowed");
      const is0 = /* @__PURE__ */ __name((i) => Fp.eql(i, Fp.ZERO), "is0");
      if (is0(x) && is0(y))
        return Point.ZERO;
      return new Point(x, y, Fp.ONE);
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    /**
     * Takes a bunch of Projective Points but executes only one
     * inversion on all of them. Inversion is very slow operation,
     * so this improves performance massively.
     * Optimization: converts a list of projective points to a list of identical points with Z=1.
     */
    static normalizeZ(points) {
      const toInv = FpInvertBatch(Fp, points.map((p) => p.pz));
      return points.map((p, i) => p.toAffine(toInv[i])).map(Point.fromAffine);
    }
    /**
     * Converts hash string or Uint8Array to Point.
     * @param hex short/long ECDSA hex
     */
    static fromHex(hex) {
      const P = Point.fromAffine(fromBytes2(ensureBytes("pointHex", hex)));
      P.assertValidity();
      return P;
    }
    // Multiplies generator point by privateKey.
    static fromPrivateKey(privateKey) {
      return Point.BASE.multiply(normPrivateKeyToScalar(privateKey));
    }
    // Multiscalar Multiplication
    static msm(points, scalars) {
      return pippenger(Point, Fn, points, scalars);
    }
    // "Private method", don't use it directly
    _setWindowSize(windowSize) {
      wnaf.setWindowSize(this, windowSize);
    }
    // A point on curve is valid if it conforms to equation.
    assertValidity() {
      assertValidMemo(this);
    }
    hasEvenY() {
      const { y } = this.toAffine();
      if (Fp.isOdd)
        return !Fp.isOdd(y);
      throw new Error("Field doesn't support isOdd");
    }
    /**
     * Compare one point to another.
     */
    equals(other) {
      aprjpoint(other);
      const { px: X1, py: Y1, pz: Z1 } = this;
      const { px: X2, py: Y2, pz: Z2 } = other;
      const U1 = Fp.eql(Fp.mul(X1, Z2), Fp.mul(X2, Z1));
      const U2 = Fp.eql(Fp.mul(Y1, Z2), Fp.mul(Y2, Z1));
      return U1 && U2;
    }
    /**
     * Flips point to one corresponding to (x, -y) in Affine coordinates.
     */
    negate() {
      return new Point(this.px, Fp.neg(this.py), this.pz);
    }
    // Renes-Costello-Batina exception-free doubling formula.
    // There is 30% faster Jacobian formula, but it is not complete.
    // https://eprint.iacr.org/2015/1060, algorithm 3
    // Cost: 8M + 3S + 3*a + 2*b3 + 15add.
    double() {
      const { a, b } = CURVE;
      const b3 = Fp.mul(b, _3n2);
      const { px: X1, py: Y1, pz: Z1 } = this;
      let X3 = Fp.ZERO, Y3 = Fp.ZERO, Z3 = Fp.ZERO;
      let t0 = Fp.mul(X1, X1);
      let t1 = Fp.mul(Y1, Y1);
      let t2 = Fp.mul(Z1, Z1);
      let t3 = Fp.mul(X1, Y1);
      t3 = Fp.add(t3, t3);
      Z3 = Fp.mul(X1, Z1);
      Z3 = Fp.add(Z3, Z3);
      X3 = Fp.mul(a, Z3);
      Y3 = Fp.mul(b3, t2);
      Y3 = Fp.add(X3, Y3);
      X3 = Fp.sub(t1, Y3);
      Y3 = Fp.add(t1, Y3);
      Y3 = Fp.mul(X3, Y3);
      X3 = Fp.mul(t3, X3);
      Z3 = Fp.mul(b3, Z3);
      t2 = Fp.mul(a, t2);
      t3 = Fp.sub(t0, t2);
      t3 = Fp.mul(a, t3);
      t3 = Fp.add(t3, Z3);
      Z3 = Fp.add(t0, t0);
      t0 = Fp.add(Z3, t0);
      t0 = Fp.add(t0, t2);
      t0 = Fp.mul(t0, t3);
      Y3 = Fp.add(Y3, t0);
      t2 = Fp.mul(Y1, Z1);
      t2 = Fp.add(t2, t2);
      t0 = Fp.mul(t2, t3);
      X3 = Fp.sub(X3, t0);
      Z3 = Fp.mul(t2, t1);
      Z3 = Fp.add(Z3, Z3);
      Z3 = Fp.add(Z3, Z3);
      return new Point(X3, Y3, Z3);
    }
    // Renes-Costello-Batina exception-free addition formula.
    // There is 30% faster Jacobian formula, but it is not complete.
    // https://eprint.iacr.org/2015/1060, algorithm 1
    // Cost: 12M + 0S + 3*a + 3*b3 + 23add.
    add(other) {
      aprjpoint(other);
      const { px: X1, py: Y1, pz: Z1 } = this;
      const { px: X2, py: Y2, pz: Z2 } = other;
      let X3 = Fp.ZERO, Y3 = Fp.ZERO, Z3 = Fp.ZERO;
      const a = CURVE.a;
      const b3 = Fp.mul(CURVE.b, _3n2);
      let t0 = Fp.mul(X1, X2);
      let t1 = Fp.mul(Y1, Y2);
      let t2 = Fp.mul(Z1, Z2);
      let t3 = Fp.add(X1, Y1);
      let t4 = Fp.add(X2, Y2);
      t3 = Fp.mul(t3, t4);
      t4 = Fp.add(t0, t1);
      t3 = Fp.sub(t3, t4);
      t4 = Fp.add(X1, Z1);
      let t5 = Fp.add(X2, Z2);
      t4 = Fp.mul(t4, t5);
      t5 = Fp.add(t0, t2);
      t4 = Fp.sub(t4, t5);
      t5 = Fp.add(Y1, Z1);
      X3 = Fp.add(Y2, Z2);
      t5 = Fp.mul(t5, X3);
      X3 = Fp.add(t1, t2);
      t5 = Fp.sub(t5, X3);
      Z3 = Fp.mul(a, t4);
      X3 = Fp.mul(b3, t2);
      Z3 = Fp.add(X3, Z3);
      X3 = Fp.sub(t1, Z3);
      Z3 = Fp.add(t1, Z3);
      Y3 = Fp.mul(X3, Z3);
      t1 = Fp.add(t0, t0);
      t1 = Fp.add(t1, t0);
      t2 = Fp.mul(a, t2);
      t4 = Fp.mul(b3, t4);
      t1 = Fp.add(t1, t2);
      t2 = Fp.sub(t0, t2);
      t2 = Fp.mul(a, t2);
      t4 = Fp.add(t4, t2);
      t0 = Fp.mul(t1, t4);
      Y3 = Fp.add(Y3, t0);
      t0 = Fp.mul(t5, t4);
      X3 = Fp.mul(t3, X3);
      X3 = Fp.sub(X3, t0);
      t0 = Fp.mul(t3, t1);
      Z3 = Fp.mul(t5, Z3);
      Z3 = Fp.add(Z3, t0);
      return new Point(X3, Y3, Z3);
    }
    subtract(other) {
      return this.add(other.negate());
    }
    is0() {
      return this.equals(Point.ZERO);
    }
    wNAF(n) {
      return wnaf.wNAFCached(this, n, Point.normalizeZ);
    }
    /**
     * Non-constant-time multiplication. Uses double-and-add algorithm.
     * It's faster, but should only be used when you don't care about
     * an exposed private key e.g. sig verification, which works over *public* keys.
     */
    multiplyUnsafe(sc) {
      const { endo: endo2, n: N } = CURVE;
      aInRange("scalar", sc, _0n4, N);
      const I = Point.ZERO;
      if (sc === _0n4)
        return I;
      if (this.is0() || sc === _1n4)
        return this;
      if (!endo2 || wnaf.hasPrecomputes(this))
        return wnaf.wNAFCachedUnsafe(this, sc, Point.normalizeZ);
      let { k1neg, k1, k2neg, k2 } = endo2.splitScalar(sc);
      let k1p = I;
      let k2p = I;
      let d = this;
      while (k1 > _0n4 || k2 > _0n4) {
        if (k1 & _1n4)
          k1p = k1p.add(d);
        if (k2 & _1n4)
          k2p = k2p.add(d);
        d = d.double();
        k1 >>= _1n4;
        k2 >>= _1n4;
      }
      if (k1neg)
        k1p = k1p.negate();
      if (k2neg)
        k2p = k2p.negate();
      k2p = new Point(Fp.mul(k2p.px, endo2.beta), k2p.py, k2p.pz);
      return k1p.add(k2p);
    }
    /**
     * Constant time multiplication.
     * Uses wNAF method. Windowed method may be 10% faster,
     * but takes 2x longer to generate and consumes 2x memory.
     * Uses precomputes when available.
     * Uses endomorphism for Koblitz curves.
     * @param scalar by which the point would be multiplied
     * @returns New point
     */
    multiply(scalar) {
      const { endo: endo2, n: N } = CURVE;
      aInRange("scalar", scalar, _1n4, N);
      let point, fake;
      if (endo2) {
        const { k1neg, k1, k2neg, k2 } = endo2.splitScalar(scalar);
        let { p: k1p, f: f1p } = this.wNAF(k1);
        let { p: k2p, f: f2p } = this.wNAF(k2);
        k1p = wnaf.constTimeNegate(k1neg, k1p);
        k2p = wnaf.constTimeNegate(k2neg, k2p);
        k2p = new Point(Fp.mul(k2p.px, endo2.beta), k2p.py, k2p.pz);
        point = k1p.add(k2p);
        fake = f1p.add(f2p);
      } else {
        const { p, f } = this.wNAF(scalar);
        point = p;
        fake = f;
      }
      return Point.normalizeZ([point, fake])[0];
    }
    /**
     * Efficiently calculate `aP + bQ`. Unsafe, can expose private key, if used incorrectly.
     * Not using Strauss-Shamir trick: precomputation tables are faster.
     * The trick could be useful if both P and Q are not G (not in our case).
     * @returns non-zero affine point
     */
    multiplyAndAddUnsafe(Q, a, b) {
      const G = Point.BASE;
      const mul = /* @__PURE__ */ __name((P, a2) => a2 === _0n4 || a2 === _1n4 || !P.equals(G) ? P.multiplyUnsafe(a2) : P.multiply(a2), "mul");
      const sum = mul(this, a).add(mul(Q, b));
      return sum.is0() ? void 0 : sum;
    }
    // Converts Projective point to affine (x, y) coordinates.
    // Can accept precomputed Z^-1 - for example, from invertBatch.
    // (x, y, z) ∋ (x=x/z, y=y/z)
    toAffine(iz) {
      return toAffineMemo(this, iz);
    }
    isTorsionFree() {
      const { h: cofactor, isTorsionFree } = CURVE;
      if (cofactor === _1n4)
        return true;
      if (isTorsionFree)
        return isTorsionFree(Point, this);
      throw new Error("isTorsionFree() has not been declared for the elliptic curve");
    }
    clearCofactor() {
      const { h: cofactor, clearCofactor } = CURVE;
      if (cofactor === _1n4)
        return this;
      if (clearCofactor)
        return clearCofactor(Point, this);
      return this.multiplyUnsafe(CURVE.h);
    }
    toRawBytes(isCompressed = true) {
      abool("isCompressed", isCompressed);
      this.assertValidity();
      return toBytes5(Point, this, isCompressed);
    }
    toHex(isCompressed = true) {
      abool("isCompressed", isCompressed);
      return bytesToHex2(this.toRawBytes(isCompressed));
    }
  }
  __name(Point, "Point");
  Point.BASE = new Point(CURVE.Gx, CURVE.Gy, Fp.ONE);
  Point.ZERO = new Point(Fp.ZERO, Fp.ONE, Fp.ZERO);
  const { endo, nBitLength } = CURVE;
  const wnaf = wNAF(Point, endo ? Math.ceil(nBitLength / 2) : nBitLength);
  return {
    CURVE,
    ProjectivePoint: Point,
    normPrivateKeyToScalar,
    weierstrassEquation,
    isWithinCurveOrder
  };
}
__name(weierstrassPoints, "weierstrassPoints");
function validateOpts(curve) {
  const opts = validateBasic(curve);
  validateObject(opts, {
    hash: "hash",
    hmac: "function",
    randomBytes: "function"
  }, {
    bits2int: "function",
    bits2int_modN: "function",
    lowS: "boolean"
  });
  return Object.freeze({ lowS: true, ...opts });
}
__name(validateOpts, "validateOpts");
function weierstrass(curveDef) {
  const CURVE = validateOpts(curveDef);
  const { Fp, n: CURVE_ORDER, nByteLength, nBitLength } = CURVE;
  const compressedLen = Fp.BYTES + 1;
  const uncompressedLen = 2 * Fp.BYTES + 1;
  function modN(a) {
    return mod(a, CURVE_ORDER);
  }
  __name(modN, "modN");
  function invN(a) {
    return invert(a, CURVE_ORDER);
  }
  __name(invN, "invN");
  const { ProjectivePoint: Point, normPrivateKeyToScalar, weierstrassEquation, isWithinCurveOrder } = weierstrassPoints({
    ...CURVE,
    toBytes(_c, point, isCompressed) {
      const a = point.toAffine();
      const x = Fp.toBytes(a.x);
      const cat = concatBytes2;
      abool("isCompressed", isCompressed);
      if (isCompressed) {
        return cat(Uint8Array.from([point.hasEvenY() ? 2 : 3]), x);
      } else {
        return cat(Uint8Array.from([4]), x, Fp.toBytes(a.y));
      }
    },
    fromBytes(bytes2) {
      const len = bytes2.length;
      const head = bytes2[0];
      const tail = bytes2.subarray(1);
      if (len === compressedLen && (head === 2 || head === 3)) {
        const x = bytesToNumberBE(tail);
        if (!inRange(x, _1n4, Fp.ORDER))
          throw new Error("Point is not on curve");
        const y2 = weierstrassEquation(x);
        let y;
        try {
          y = Fp.sqrt(y2);
        } catch (sqrtError) {
          const suffix = sqrtError instanceof Error ? ": " + sqrtError.message : "";
          throw new Error("Point is not on curve" + suffix);
        }
        const isYOdd = (y & _1n4) === _1n4;
        const isHeadOdd = (head & 1) === 1;
        if (isHeadOdd !== isYOdd)
          y = Fp.neg(y);
        return { x, y };
      } else if (len === uncompressedLen && head === 4) {
        const x = Fp.fromBytes(tail.subarray(0, Fp.BYTES));
        const y = Fp.fromBytes(tail.subarray(Fp.BYTES, 2 * Fp.BYTES));
        return { x, y };
      } else {
        const cl = compressedLen;
        const ul = uncompressedLen;
        throw new Error("invalid Point, expected length of " + cl + ", or uncompressed " + ul + ", got " + len);
      }
    }
  });
  function isBiggerThanHalfOrder(number) {
    const HALF = CURVE_ORDER >> _1n4;
    return number > HALF;
  }
  __name(isBiggerThanHalfOrder, "isBiggerThanHalfOrder");
  function normalizeS(s) {
    return isBiggerThanHalfOrder(s) ? modN(-s) : s;
  }
  __name(normalizeS, "normalizeS");
  const slcNum = /* @__PURE__ */ __name((b, from6, to) => bytesToNumberBE(b.slice(from6, to)), "slcNum");
  class Signature {
    constructor(r, s, recovery) {
      aInRange("r", r, _1n4, CURVE_ORDER);
      aInRange("s", s, _1n4, CURVE_ORDER);
      this.r = r;
      this.s = s;
      if (recovery != null)
        this.recovery = recovery;
      Object.freeze(this);
    }
    // pair (bytes of r, bytes of s)
    static fromCompact(hex) {
      const l = nByteLength;
      hex = ensureBytes("compactSignature", hex, l * 2);
      return new Signature(slcNum(hex, 0, l), slcNum(hex, l, 2 * l));
    }
    // DER encoded ECDSA signature
    // https://bitcoin.stackexchange.com/questions/57644/what-are-the-parts-of-a-bitcoin-transaction-input-script
    static fromDER(hex) {
      const { r, s } = DER.toSig(ensureBytes("DER", hex));
      return new Signature(r, s);
    }
    /**
     * @todo remove
     * @deprecated
     */
    assertValidity() {
    }
    addRecoveryBit(recovery) {
      return new Signature(this.r, this.s, recovery);
    }
    recoverPublicKey(msgHash) {
      const { r, s, recovery: rec } = this;
      const h = bits2int_modN(ensureBytes("msgHash", msgHash));
      if (rec == null || ![0, 1, 2, 3].includes(rec))
        throw new Error("recovery id invalid");
      const radj = rec === 2 || rec === 3 ? r + CURVE.n : r;
      if (radj >= Fp.ORDER)
        throw new Error("recovery id 2 or 3 invalid");
      const prefix2 = (rec & 1) === 0 ? "02" : "03";
      const R = Point.fromHex(prefix2 + numToSizedHex(radj, Fp.BYTES));
      const ir = invN(radj);
      const u1 = modN(-h * ir);
      const u2 = modN(s * ir);
      const Q = Point.BASE.multiplyAndAddUnsafe(R, u1, u2);
      if (!Q)
        throw new Error("point at infinify");
      Q.assertValidity();
      return Q;
    }
    // Signatures should be low-s, to prevent malleability.
    hasHighS() {
      return isBiggerThanHalfOrder(this.s);
    }
    normalizeS() {
      return this.hasHighS() ? new Signature(this.r, modN(-this.s), this.recovery) : this;
    }
    // DER-encoded
    toDERRawBytes() {
      return hexToBytes2(this.toDERHex());
    }
    toDERHex() {
      return DER.hexFromSig(this);
    }
    // padded bytes of r, then padded bytes of s
    toCompactRawBytes() {
      return hexToBytes2(this.toCompactHex());
    }
    toCompactHex() {
      const l = nByteLength;
      return numToSizedHex(this.r, l) + numToSizedHex(this.s, l);
    }
  }
  __name(Signature, "Signature");
  const utils = {
    isValidPrivateKey(privateKey) {
      try {
        normPrivateKeyToScalar(privateKey);
        return true;
      } catch (error) {
        return false;
      }
    },
    normPrivateKeyToScalar,
    /**
     * Produces cryptographically secure private key from random of size
     * (groupLen + ceil(groupLen / 2)) with modulo bias being negligible.
     */
    randomPrivateKey: () => {
      const length2 = getMinHashLength(CURVE.n);
      return mapHashToField(CURVE.randomBytes(length2), CURVE.n);
    },
    /**
     * Creates precompute table for an arbitrary EC point. Makes point "cached".
     * Allows to massively speed-up `point.multiply(scalar)`.
     * @returns cached point
     * @example
     * const fast = utils.precompute(8, ProjectivePoint.fromHex(someonesPubKey));
     * fast.multiply(privKey); // much faster ECDH now
     */
    precompute(windowSize = 8, point = Point.BASE) {
      point._setWindowSize(windowSize);
      point.multiply(BigInt(3));
      return point;
    }
  };
  function getPublicKey(privateKey, isCompressed = true) {
    return Point.fromPrivateKey(privateKey).toRawBytes(isCompressed);
  }
  __name(getPublicKey, "getPublicKey");
  function isProbPub(item) {
    if (typeof item === "bigint")
      return false;
    if (item instanceof Point)
      return true;
    const arr = ensureBytes("key", item);
    const len = arr.length;
    const fpl = Fp.BYTES;
    const compLen = fpl + 1;
    const uncompLen = 2 * fpl + 1;
    if (CURVE.allowedPrivateKeyLengths || nByteLength === compLen) {
      return void 0;
    } else {
      return len === compLen || len === uncompLen;
    }
  }
  __name(isProbPub, "isProbPub");
  function getSharedSecret(privateA, publicB, isCompressed = true) {
    if (isProbPub(privateA) === true)
      throw new Error("first arg must be private key");
    if (isProbPub(publicB) === false)
      throw new Error("second arg must be public key");
    const b = Point.fromHex(publicB);
    return b.multiply(normPrivateKeyToScalar(privateA)).toRawBytes(isCompressed);
  }
  __name(getSharedSecret, "getSharedSecret");
  const bits2int = CURVE.bits2int || function(bytes2) {
    if (bytes2.length > 8192)
      throw new Error("input is too large");
    const num = bytesToNumberBE(bytes2);
    const delta = bytes2.length * 8 - nBitLength;
    return delta > 0 ? num >> BigInt(delta) : num;
  };
  const bits2int_modN = CURVE.bits2int_modN || function(bytes2) {
    return modN(bits2int(bytes2));
  };
  const ORDER_MASK = bitMask(nBitLength);
  function int2octets(num) {
    aInRange("num < 2^" + nBitLength, num, _0n4, ORDER_MASK);
    return numberToBytesBE(num, nByteLength);
  }
  __name(int2octets, "int2octets");
  function prepSig(msgHash, privateKey, opts = defaultSigOpts) {
    if (["recovered", "canonical"].some((k) => k in opts))
      throw new Error("sign() legacy options not supported");
    const { hash, randomBytes: randomBytes2 } = CURVE;
    let { lowS, prehash, extraEntropy: ent } = opts;
    if (lowS == null)
      lowS = true;
    msgHash = ensureBytes("msgHash", msgHash);
    validateSigVerOpts(opts);
    if (prehash)
      msgHash = ensureBytes("prehashed msgHash", hash(msgHash));
    const h1int = bits2int_modN(msgHash);
    const d = normPrivateKeyToScalar(privateKey);
    const seedArgs = [int2octets(d), int2octets(h1int)];
    if (ent != null && ent !== false) {
      const e = ent === true ? randomBytes2(Fp.BYTES) : ent;
      seedArgs.push(ensureBytes("extraEntropy", e));
    }
    const seed = concatBytes2(...seedArgs);
    const m = h1int;
    function k2sig(kBytes) {
      const k = bits2int(kBytes);
      if (!isWithinCurveOrder(k))
        return;
      const ik = invN(k);
      const q = Point.BASE.multiply(k).toAffine();
      const r = modN(q.x);
      if (r === _0n4)
        return;
      const s = modN(ik * modN(m + r * d));
      if (s === _0n4)
        return;
      let recovery = (q.x === r ? 0 : 2) | Number(q.y & _1n4);
      let normS = s;
      if (lowS && isBiggerThanHalfOrder(s)) {
        normS = normalizeS(s);
        recovery ^= 1;
      }
      return new Signature(r, normS, recovery);
    }
    __name(k2sig, "k2sig");
    return { seed, k2sig };
  }
  __name(prepSig, "prepSig");
  const defaultSigOpts = { lowS: CURVE.lowS, prehash: false };
  const defaultVerOpts = { lowS: CURVE.lowS, prehash: false };
  function sign2(msgHash, privKey, opts = defaultSigOpts) {
    const { seed, k2sig } = prepSig(msgHash, privKey, opts);
    const C = CURVE;
    const drbg = createHmacDrbg(C.hash.outputLen, C.nByteLength, C.hmac);
    return drbg(seed, k2sig);
  }
  __name(sign2, "sign");
  Point.BASE._setWindowSize(8);
  function verify(signature, msgHash, publicKey, opts = defaultVerOpts) {
    const sg = signature;
    msgHash = ensureBytes("msgHash", msgHash);
    publicKey = ensureBytes("publicKey", publicKey);
    const { lowS, prehash, format: format3 } = opts;
    validateSigVerOpts(opts);
    if ("strict" in opts)
      throw new Error("options.strict was renamed to lowS");
    if (format3 !== void 0 && format3 !== "compact" && format3 !== "der")
      throw new Error("format must be compact or der");
    const isHex2 = typeof sg === "string" || isBytes2(sg);
    const isObj = !isHex2 && !format3 && typeof sg === "object" && sg !== null && typeof sg.r === "bigint" && typeof sg.s === "bigint";
    if (!isHex2 && !isObj)
      throw new Error("invalid signature, expected Uint8Array, hex string or Signature instance");
    let _sig = void 0;
    let P;
    try {
      if (isObj)
        _sig = new Signature(sg.r, sg.s);
      if (isHex2) {
        try {
          if (format3 !== "compact")
            _sig = Signature.fromDER(sg);
        } catch (derError) {
          if (!(derError instanceof DER.Err))
            throw derError;
        }
        if (!_sig && format3 !== "der")
          _sig = Signature.fromCompact(sg);
      }
      P = Point.fromHex(publicKey);
    } catch (error) {
      return false;
    }
    if (!_sig)
      return false;
    if (lowS && _sig.hasHighS())
      return false;
    if (prehash)
      msgHash = CURVE.hash(msgHash);
    const { r, s } = _sig;
    const h = bits2int_modN(msgHash);
    const is2 = invN(s);
    const u1 = modN(h * is2);
    const u2 = modN(r * is2);
    const R = Point.BASE.multiplyAndAddUnsafe(P, u1, u2)?.toAffine();
    if (!R)
      return false;
    const v = modN(R.x);
    return v === r;
  }
  __name(verify, "verify");
  return {
    CURVE,
    getPublicKey,
    getSharedSecret,
    sign: sign2,
    verify,
    ProjectivePoint: Point,
    Signature,
    utils
  };
}
__name(weierstrass, "weierstrass");

// node_modules/viem/node_modules/@noble/curves/esm/_shortw_utils.js
function getHash(hash) {
  return {
    hash,
    hmac: (key, ...msgs) => hmac(hash, key, concatBytes(...msgs)),
    randomBytes
  };
}
__name(getHash, "getHash");
function createCurve(curveDef, defHash) {
  const create6 = /* @__PURE__ */ __name((hash) => weierstrass({ ...curveDef, ...getHash(hash) }), "create");
  return { ...create6(defHash), create: create6 };
}
__name(createCurve, "createCurve");

// node_modules/viem/node_modules/@noble/curves/esm/secp256k1.js
var secp256k1P = BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f");
var secp256k1N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
var _0n5 = BigInt(0);
var _1n5 = BigInt(1);
var _2n3 = BigInt(2);
var divNearest = /* @__PURE__ */ __name((a, b) => (a + b / _2n3) / b, "divNearest");
function sqrtMod(y) {
  const P = secp256k1P;
  const _3n3 = BigInt(3), _6n = BigInt(6), _11n = BigInt(11), _22n = BigInt(22);
  const _23n = BigInt(23), _44n = BigInt(44), _88n = BigInt(88);
  const b2 = y * y * y % P;
  const b3 = b2 * b2 * y % P;
  const b6 = pow22(b3, _3n3, P) * b3 % P;
  const b9 = pow22(b6, _3n3, P) * b3 % P;
  const b11 = pow22(b9, _2n3, P) * b2 % P;
  const b22 = pow22(b11, _11n, P) * b11 % P;
  const b44 = pow22(b22, _22n, P) * b22 % P;
  const b88 = pow22(b44, _44n, P) * b44 % P;
  const b176 = pow22(b88, _88n, P) * b88 % P;
  const b220 = pow22(b176, _44n, P) * b44 % P;
  const b223 = pow22(b220, _3n3, P) * b3 % P;
  const t1 = pow22(b223, _23n, P) * b22 % P;
  const t2 = pow22(t1, _6n, P) * b2 % P;
  const root2 = pow22(t2, _2n3, P);
  if (!Fpk1.eql(Fpk1.sqr(root2), y))
    throw new Error("Cannot find square root");
  return root2;
}
__name(sqrtMod, "sqrtMod");
var Fpk1 = Field(secp256k1P, void 0, void 0, { sqrt: sqrtMod });
var secp256k1 = createCurve({
  a: _0n5,
  b: BigInt(7),
  Fp: Fpk1,
  n: secp256k1N,
  Gx: BigInt("55066263022277343669578718895168534326250603453777594175500187360389116729240"),
  Gy: BigInt("32670510020758816978083085130507043184471273380659243275938904335757337482424"),
  h: BigInt(1),
  lowS: true,
  // Allow only low-S signatures by default in sign() and verify()
  endo: {
    // Endomorphism, see above
    beta: BigInt("0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee"),
    splitScalar: (k) => {
      const n = secp256k1N;
      const a1 = BigInt("0x3086d221a7d46bcde86c90e49284eb15");
      const b1 = -_1n5 * BigInt("0xe4437ed6010e88286f547fa90abfe4c3");
      const a2 = BigInt("0x114ca50f7a8e2f3f657c1108d9d44cfd8");
      const b2 = a1;
      const POW_2_128 = BigInt("0x100000000000000000000000000000000");
      const c1 = divNearest(b2 * k, n);
      const c2 = divNearest(-b1 * k, n);
      let k1 = mod(k - c1 * a1 - c2 * a2, n);
      let k2 = mod(-c1 * b1 - c2 * b2, n);
      const k1neg = k1 > POW_2_128;
      const k2neg = k2 > POW_2_128;
      if (k1neg)
        k1 = n - k1;
      if (k2neg)
        k2 = n - k2;
      if (k1 > POW_2_128 || k2 > POW_2_128) {
        throw new Error("splitScalar: Endomorphism failed, k=" + k);
      }
      return { k1neg, k1, k2neg, k2 };
    }
  }
}, sha2562);

// node_modules/viem/_esm/utils/signature/serializeSignature.js
function serializeSignature({ r, s, to = "hex", v, yParity }) {
  const yParity_ = (() => {
    if (yParity === 0 || yParity === 1)
      return yParity;
    if (v && (v === 27n || v === 28n || v >= 35n))
      return v % 2n === 0n ? 1 : 0;
    throw new Error("Invalid `v` or `yParity` value");
  })();
  const signature = `0x${new secp256k1.Signature(hexToBigInt(r), hexToBigInt(s)).toCompactHex()}${yParity_ === 0 ? "1b" : "1c"}`;
  if (to === "hex")
    return signature;
  return hexToBytes(signature);
}
__name(serializeSignature, "serializeSignature");

// node_modules/viem/_esm/errors/address.js
var InvalidAddressError = class extends BaseError {
  constructor({ address }) {
    super(`Address "${address}" is invalid.`, {
      metaMessages: [
        "- Address must be a hex value of 20 bytes (40 hex characters).",
        "- Address must match its checksum counterpart."
      ],
      name: "InvalidAddressError"
    });
  }
};
__name(InvalidAddressError, "InvalidAddressError");

// node_modules/viem/node_modules/@noble/hashes/esm/sha3.js
var _0n6 = BigInt(0);
var _1n6 = BigInt(1);
var _2n4 = BigInt(2);
var _7n = BigInt(7);
var _256n = BigInt(256);
var _0x71n = BigInt(113);
var SHA3_PI = [];
var SHA3_ROTL = [];
var _SHA3_IOTA = [];
for (let round = 0, R = _1n6, x = 1, y = 0; round < 24; round++) {
  [x, y] = [y, (2 * x + 3 * y) % 5];
  SHA3_PI.push(2 * (5 * y + x));
  SHA3_ROTL.push((round + 1) * (round + 2) / 2 % 64);
  let t = _0n6;
  for (let j = 0; j < 7; j++) {
    R = (R << _1n6 ^ (R >> _7n) * _0x71n) % _256n;
    if (R & _2n4)
      t ^= _1n6 << (_1n6 << /* @__PURE__ */ BigInt(j)) - _1n6;
  }
  _SHA3_IOTA.push(t);
}
var IOTAS = split2(_SHA3_IOTA, true);
var SHA3_IOTA_H = IOTAS[0];
var SHA3_IOTA_L = IOTAS[1];
var rotlH = /* @__PURE__ */ __name((h, l, s) => s > 32 ? rotlBH(h, l, s) : rotlSH(h, l, s), "rotlH");
var rotlL = /* @__PURE__ */ __name((h, l, s) => s > 32 ? rotlBL(h, l, s) : rotlSL(h, l, s), "rotlL");
function keccakP(s, rounds = 24) {
  const B = new Uint32Array(5 * 2);
  for (let round = 24 - rounds; round < 24; round++) {
    for (let x = 0; x < 10; x++)
      B[x] = s[x] ^ s[x + 10] ^ s[x + 20] ^ s[x + 30] ^ s[x + 40];
    for (let x = 0; x < 10; x += 2) {
      const idx1 = (x + 8) % 10;
      const idx0 = (x + 2) % 10;
      const B0 = B[idx0];
      const B1 = B[idx0 + 1];
      const Th = rotlH(B0, B1, 1) ^ B[idx1];
      const Tl = rotlL(B0, B1, 1) ^ B[idx1 + 1];
      for (let y = 0; y < 50; y += 10) {
        s[x + y] ^= Th;
        s[x + y + 1] ^= Tl;
      }
    }
    let curH = s[2];
    let curL = s[3];
    for (let t = 0; t < 24; t++) {
      const shift = SHA3_ROTL[t];
      const Th = rotlH(curH, curL, shift);
      const Tl = rotlL(curH, curL, shift);
      const PI = SHA3_PI[t];
      curH = s[PI];
      curL = s[PI + 1];
      s[PI] = Th;
      s[PI + 1] = Tl;
    }
    for (let y = 0; y < 50; y += 10) {
      for (let x = 0; x < 10; x++)
        B[x] = s[y + x];
      for (let x = 0; x < 10; x++)
        s[y + x] ^= ~B[(x + 2) % 10] & B[(x + 4) % 10];
    }
    s[0] ^= SHA3_IOTA_H[round];
    s[1] ^= SHA3_IOTA_L[round];
  }
  clean(B);
}
__name(keccakP, "keccakP");
var Keccak = class extends Hash2 {
  // NOTE: we accept arguments in bytes instead of bits here.
  constructor(blockLen, suffix, outputLen, enableXOF = false, rounds = 24) {
    super();
    this.pos = 0;
    this.posOut = 0;
    this.finished = false;
    this.destroyed = false;
    this.enableXOF = false;
    this.blockLen = blockLen;
    this.suffix = suffix;
    this.outputLen = outputLen;
    this.enableXOF = enableXOF;
    this.rounds = rounds;
    anumber(outputLen);
    if (!(0 < blockLen && blockLen < 200))
      throw new Error("only keccak-f1600 function is supported");
    this.state = new Uint8Array(200);
    this.state32 = u32(this.state);
  }
  clone() {
    return this._cloneInto();
  }
  keccak() {
    swap32IfBE(this.state32);
    keccakP(this.state32, this.rounds);
    swap32IfBE(this.state32);
    this.posOut = 0;
    this.pos = 0;
  }
  update(data) {
    aexists(this);
    data = toBytes4(data);
    abytes(data);
    const { blockLen, state } = this;
    const len = data.length;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      for (let i = 0; i < take; i++)
        state[this.pos++] ^= data[pos++];
      if (this.pos === blockLen)
        this.keccak();
    }
    return this;
  }
  finish() {
    if (this.finished)
      return;
    this.finished = true;
    const { state, suffix, pos, blockLen } = this;
    state[pos] ^= suffix;
    if ((suffix & 128) !== 0 && pos === blockLen - 1)
      this.keccak();
    state[blockLen - 1] ^= 128;
    this.keccak();
  }
  writeInto(out) {
    aexists(this, false);
    abytes(out);
    this.finish();
    const bufferOut = this.state;
    const { blockLen } = this;
    for (let pos = 0, len = out.length; pos < len; ) {
      if (this.posOut >= blockLen)
        this.keccak();
      const take = Math.min(blockLen - this.posOut, len - pos);
      out.set(bufferOut.subarray(this.posOut, this.posOut + take), pos);
      this.posOut += take;
      pos += take;
    }
    return out;
  }
  xofInto(out) {
    if (!this.enableXOF)
      throw new Error("XOF is not possible for this instance");
    return this.writeInto(out);
  }
  xof(bytes2) {
    anumber(bytes2);
    return this.xofInto(new Uint8Array(bytes2));
  }
  digestInto(out) {
    aoutput(out, this);
    if (this.finished)
      throw new Error("digest() was already called");
    this.writeInto(out);
    this.destroy();
    return out;
  }
  digest() {
    return this.digestInto(new Uint8Array(this.outputLen));
  }
  destroy() {
    this.destroyed = true;
    clean(this.state);
  }
  _cloneInto(to) {
    const { blockLen, suffix, outputLen, rounds, enableXOF } = this;
    to || (to = new Keccak(blockLen, suffix, outputLen, enableXOF, rounds));
    to.state32.set(this.state32);
    to.pos = this.pos;
    to.posOut = this.posOut;
    to.finished = this.finished;
    to.rounds = rounds;
    to.suffix = suffix;
    to.outputLen = outputLen;
    to.enableXOF = enableXOF;
    to.destroyed = this.destroyed;
    return to;
  }
};
__name(Keccak, "Keccak");
var gen = /* @__PURE__ */ __name((suffix, blockLen, outputLen) => createHasher(() => new Keccak(blockLen, suffix, outputLen)), "gen");
var keccak_256 = /* @__PURE__ */ (() => gen(1, 136, 256 / 8))();

// node_modules/viem/_esm/utils/hash/keccak256.js
function keccak256(value, to_) {
  const to = to_ || "hex";
  const bytes2 = keccak_256(isHex(value, { strict: false }) ? toBytes3(value) : value);
  if (to === "bytes")
    return bytes2;
  return toHex(bytes2);
}
__name(keccak256, "keccak256");

// node_modules/viem/_esm/utils/address/getAddress.js
var checksumAddressCache = /* @__PURE__ */ new LruMap(8192);
function checksumAddress(address_, chainId) {
  if (checksumAddressCache.has(`${address_}.${chainId}`))
    return checksumAddressCache.get(`${address_}.${chainId}`);
  const hexAddress = chainId ? `${chainId}${address_.toLowerCase()}` : address_.substring(2).toLowerCase();
  const hash = keccak256(stringToBytes(hexAddress), "bytes");
  const address = (chainId ? hexAddress.substring(`${chainId}0x`.length) : hexAddress).split("");
  for (let i = 0; i < 40; i += 2) {
    if (hash[i >> 1] >> 4 >= 8 && address[i]) {
      address[i] = address[i].toUpperCase();
    }
    if ((hash[i >> 1] & 15) >= 8 && address[i + 1]) {
      address[i + 1] = address[i + 1].toUpperCase();
    }
  }
  const result = `0x${address.join("")}`;
  checksumAddressCache.set(`${address_}.${chainId}`, result);
  return result;
}
__name(checksumAddress, "checksumAddress");

// node_modules/viem/_esm/utils/address/isAddress.js
var addressRegex = /^0x[a-fA-F0-9]{40}$/;
var isAddressCache = /* @__PURE__ */ new LruMap(8192);
function isAddress(address, options) {
  const { strict = true } = options ?? {};
  const cacheKey = `${address}.${strict}`;
  if (isAddressCache.has(cacheKey))
    return isAddressCache.get(cacheKey);
  const result = (() => {
    if (!addressRegex.test(address))
      return false;
    if (address.toLowerCase() === address)
      return true;
    if (strict)
      return checksumAddress(address) === address;
    return true;
  })();
  isAddressCache.set(cacheKey, result);
  return result;
}
__name(isAddress, "isAddress");

// node_modules/viem/_esm/accounts/toAccount.js
function toAccount(source) {
  if (typeof source === "string") {
    if (!isAddress(source, { strict: false }))
      throw new InvalidAddressError({ address: source });
    return {
      address: source,
      type: "json-rpc"
    };
  }
  if (!isAddress(source.address, { strict: false }))
    throw new InvalidAddressError({ address: source.address });
  return {
    address: source.address,
    nonceManager: source.nonceManager,
    sign: source.sign,
    signAuthorization: source.signAuthorization,
    signMessage: source.signMessage,
    signTransaction: source.signTransaction,
    signTypedData: source.signTypedData,
    source: "custom",
    type: "local"
  };
}
__name(toAccount, "toAccount");

// node_modules/viem/_esm/accounts/utils/publicKeyToAddress.js
function publicKeyToAddress(publicKey) {
  const address = keccak256(`0x${publicKey.substring(4)}`).substring(26);
  return checksumAddress(`0x${address}`);
}
__name(publicKeyToAddress, "publicKeyToAddress");

// node_modules/viem/_esm/accounts/utils/sign.js
var extraEntropy = false;
async function sign({ hash, privateKey, to = "object" }) {
  const { r, s, recovery } = secp256k1.sign(hash.slice(2), privateKey.slice(2), {
    lowS: true,
    extraEntropy: isHex(extraEntropy, { strict: false }) ? hexToBytes(extraEntropy) : extraEntropy
  });
  const signature = {
    r: numberToHex(r, { size: 32 }),
    s: numberToHex(s, { size: 32 }),
    v: recovery ? 28n : 27n,
    yParity: recovery
  };
  return (() => {
    if (to === "bytes" || to === "hex")
      return serializeSignature({ ...signature, to });
    return signature;
  })();
}
__name(sign, "sign");

// node_modules/viem/_esm/utils/data/concat.js
function concat2(values) {
  if (typeof values[0] === "string")
    return concatHex(values);
  return concatBytes3(values);
}
__name(concat2, "concat");
function concatBytes3(values) {
  let length2 = 0;
  for (const arr of values) {
    length2 += arr.length;
  }
  const result = new Uint8Array(length2);
  let offset2 = 0;
  for (const arr of values) {
    result.set(arr, offset2);
    offset2 += arr.length;
  }
  return result;
}
__name(concatBytes3, "concatBytes");
function concatHex(values) {
  return `0x${values.reduce((acc, x) => acc + x.replace("0x", ""), "")}`;
}
__name(concatHex, "concatHex");

// node_modules/viem/_esm/errors/cursor.js
var NegativeOffsetError = class extends BaseError {
  constructor({ offset: offset2 }) {
    super(`Offset \`${offset2}\` cannot be negative.`, {
      name: "NegativeOffsetError"
    });
  }
};
__name(NegativeOffsetError, "NegativeOffsetError");
var PositionOutOfBoundsError = class extends BaseError {
  constructor({ length: length2, position }) {
    super(`Position \`${position}\` is out of bounds (\`0 < position < ${length2}\`).`, { name: "PositionOutOfBoundsError" });
  }
};
__name(PositionOutOfBoundsError, "PositionOutOfBoundsError");
var RecursiveReadLimitExceededError = class extends BaseError {
  constructor({ count, limit }) {
    super(`Recursive read limit of \`${limit}\` exceeded (recursive read count: \`${count}\`).`, { name: "RecursiveReadLimitExceededError" });
  }
};
__name(RecursiveReadLimitExceededError, "RecursiveReadLimitExceededError");

// node_modules/viem/_esm/utils/cursor.js
var staticCursor = {
  bytes: new Uint8Array(),
  dataView: new DataView(new ArrayBuffer(0)),
  position: 0,
  positionReadCount: /* @__PURE__ */ new Map(),
  recursiveReadCount: 0,
  recursiveReadLimit: Number.POSITIVE_INFINITY,
  assertReadLimit() {
    if (this.recursiveReadCount >= this.recursiveReadLimit)
      throw new RecursiveReadLimitExceededError({
        count: this.recursiveReadCount + 1,
        limit: this.recursiveReadLimit
      });
  },
  assertPosition(position) {
    if (position < 0 || position > this.bytes.length - 1)
      throw new PositionOutOfBoundsError({
        length: this.bytes.length,
        position
      });
  },
  decrementPosition(offset2) {
    if (offset2 < 0)
      throw new NegativeOffsetError({ offset: offset2 });
    const position = this.position - offset2;
    this.assertPosition(position);
    this.position = position;
  },
  getReadCount(position) {
    return this.positionReadCount.get(position || this.position) || 0;
  },
  incrementPosition(offset2) {
    if (offset2 < 0)
      throw new NegativeOffsetError({ offset: offset2 });
    const position = this.position + offset2;
    this.assertPosition(position);
    this.position = position;
  },
  inspectByte(position_) {
    const position = position_ ?? this.position;
    this.assertPosition(position);
    return this.bytes[position];
  },
  inspectBytes(length2, position_) {
    const position = position_ ?? this.position;
    this.assertPosition(position + length2 - 1);
    return this.bytes.subarray(position, position + length2);
  },
  inspectUint8(position_) {
    const position = position_ ?? this.position;
    this.assertPosition(position);
    return this.bytes[position];
  },
  inspectUint16(position_) {
    const position = position_ ?? this.position;
    this.assertPosition(position + 1);
    return this.dataView.getUint16(position);
  },
  inspectUint24(position_) {
    const position = position_ ?? this.position;
    this.assertPosition(position + 2);
    return (this.dataView.getUint16(position) << 8) + this.dataView.getUint8(position + 2);
  },
  inspectUint32(position_) {
    const position = position_ ?? this.position;
    this.assertPosition(position + 3);
    return this.dataView.getUint32(position);
  },
  pushByte(byte) {
    this.assertPosition(this.position);
    this.bytes[this.position] = byte;
    this.position++;
  },
  pushBytes(bytes2) {
    this.assertPosition(this.position + bytes2.length - 1);
    this.bytes.set(bytes2, this.position);
    this.position += bytes2.length;
  },
  pushUint8(value) {
    this.assertPosition(this.position);
    this.bytes[this.position] = value;
    this.position++;
  },
  pushUint16(value) {
    this.assertPosition(this.position + 1);
    this.dataView.setUint16(this.position, value);
    this.position += 2;
  },
  pushUint24(value) {
    this.assertPosition(this.position + 2);
    this.dataView.setUint16(this.position, value >> 8);
    this.dataView.setUint8(this.position + 2, value & ~4294967040);
    this.position += 3;
  },
  pushUint32(value) {
    this.assertPosition(this.position + 3);
    this.dataView.setUint32(this.position, value);
    this.position += 4;
  },
  readByte() {
    this.assertReadLimit();
    this._touch();
    const value = this.inspectByte();
    this.position++;
    return value;
  },
  readBytes(length2, size3) {
    this.assertReadLimit();
    this._touch();
    const value = this.inspectBytes(length2);
    this.position += size3 ?? length2;
    return value;
  },
  readUint8() {
    this.assertReadLimit();
    this._touch();
    const value = this.inspectUint8();
    this.position += 1;
    return value;
  },
  readUint16() {
    this.assertReadLimit();
    this._touch();
    const value = this.inspectUint16();
    this.position += 2;
    return value;
  },
  readUint24() {
    this.assertReadLimit();
    this._touch();
    const value = this.inspectUint24();
    this.position += 3;
    return value;
  },
  readUint32() {
    this.assertReadLimit();
    this._touch();
    const value = this.inspectUint32();
    this.position += 4;
    return value;
  },
  get remaining() {
    return this.bytes.length - this.position;
  },
  setPosition(position) {
    const oldPosition = this.position;
    this.assertPosition(position);
    this.position = position;
    return () => this.position = oldPosition;
  },
  _touch() {
    if (this.recursiveReadLimit === Number.POSITIVE_INFINITY)
      return;
    const count = this.getReadCount();
    this.positionReadCount.set(this.position, count + 1);
    if (count > 0)
      this.recursiveReadCount++;
  }
};
function createCursor(bytes2, { recursiveReadLimit = 8192 } = {}) {
  const cursor = Object.create(staticCursor);
  cursor.bytes = bytes2;
  cursor.dataView = new DataView(bytes2.buffer ?? bytes2, bytes2.byteOffset, bytes2.byteLength);
  cursor.positionReadCount = /* @__PURE__ */ new Map();
  cursor.recursiveReadLimit = recursiveReadLimit;
  return cursor;
}
__name(createCursor, "createCursor");

// node_modules/viem/_esm/utils/encoding/toRlp.js
function toRlp(bytes2, to = "hex") {
  const encodable = getEncodable(bytes2);
  const cursor = createCursor(new Uint8Array(encodable.length));
  encodable.encode(cursor);
  if (to === "hex")
    return bytesToHex(cursor.bytes);
  return cursor.bytes;
}
__name(toRlp, "toRlp");
function getEncodable(bytes2) {
  if (Array.isArray(bytes2))
    return getEncodableList(bytes2.map((x) => getEncodable(x)));
  return getEncodableBytes(bytes2);
}
__name(getEncodable, "getEncodable");
function getEncodableList(list) {
  const bodyLength = list.reduce((acc, x) => acc + x.length, 0);
  const sizeOfBodyLength = getSizeOfLength(bodyLength);
  const length2 = (() => {
    if (bodyLength <= 55)
      return 1 + bodyLength;
    return 1 + sizeOfBodyLength + bodyLength;
  })();
  return {
    length: length2,
    encode(cursor) {
      if (bodyLength <= 55) {
        cursor.pushByte(192 + bodyLength);
      } else {
        cursor.pushByte(192 + 55 + sizeOfBodyLength);
        if (sizeOfBodyLength === 1)
          cursor.pushUint8(bodyLength);
        else if (sizeOfBodyLength === 2)
          cursor.pushUint16(bodyLength);
        else if (sizeOfBodyLength === 3)
          cursor.pushUint24(bodyLength);
        else
          cursor.pushUint32(bodyLength);
      }
      for (const { encode: encode5 } of list) {
        encode5(cursor);
      }
    }
  };
}
__name(getEncodableList, "getEncodableList");
function getEncodableBytes(bytesOrHex) {
  const bytes2 = typeof bytesOrHex === "string" ? hexToBytes(bytesOrHex) : bytesOrHex;
  const sizeOfBytesLength = getSizeOfLength(bytes2.length);
  const length2 = (() => {
    if (bytes2.length === 1 && bytes2[0] < 128)
      return 1;
    if (bytes2.length <= 55)
      return 1 + bytes2.length;
    return 1 + sizeOfBytesLength + bytes2.length;
  })();
  return {
    length: length2,
    encode(cursor) {
      if (bytes2.length === 1 && bytes2[0] < 128) {
        cursor.pushBytes(bytes2);
      } else if (bytes2.length <= 55) {
        cursor.pushByte(128 + bytes2.length);
        cursor.pushBytes(bytes2);
      } else {
        cursor.pushByte(128 + 55 + sizeOfBytesLength);
        if (sizeOfBytesLength === 1)
          cursor.pushUint8(bytes2.length);
        else if (sizeOfBytesLength === 2)
          cursor.pushUint16(bytes2.length);
        else if (sizeOfBytesLength === 3)
          cursor.pushUint24(bytes2.length);
        else
          cursor.pushUint32(bytes2.length);
        cursor.pushBytes(bytes2);
      }
    }
  };
}
__name(getEncodableBytes, "getEncodableBytes");
function getSizeOfLength(length2) {
  if (length2 < 2 ** 8)
    return 1;
  if (length2 < 2 ** 16)
    return 2;
  if (length2 < 2 ** 24)
    return 3;
  if (length2 < 2 ** 32)
    return 4;
  throw new BaseError("Length is too large.");
}
__name(getSizeOfLength, "getSizeOfLength");

// node_modules/viem/_esm/utils/authorization/hashAuthorization.js
function hashAuthorization(parameters) {
  const { chainId, nonce, to } = parameters;
  const address = parameters.contractAddress ?? parameters.address;
  const hash = keccak256(concatHex([
    "0x05",
    toRlp([
      chainId ? numberToHex(chainId) : "0x",
      address,
      nonce ? numberToHex(nonce) : "0x"
    ])
  ]));
  if (to === "bytes")
    return hexToBytes(hash);
  return hash;
}
__name(hashAuthorization, "hashAuthorization");

// node_modules/viem/_esm/accounts/utils/signAuthorization.js
async function signAuthorization(parameters) {
  const { chainId, nonce, privateKey, to = "object" } = parameters;
  const address = parameters.contractAddress ?? parameters.address;
  const signature = await sign({
    hash: hashAuthorization({ address, chainId, nonce }),
    privateKey,
    to
  });
  if (to === "object")
    return {
      address,
      chainId,
      nonce,
      ...signature
    };
  return signature;
}
__name(signAuthorization, "signAuthorization");

// node_modules/viem/_esm/constants/strings.js
var presignMessagePrefix = "Ethereum Signed Message:\n";

// node_modules/viem/_esm/utils/signature/toPrefixedMessage.js
function toPrefixedMessage(message_) {
  const message = (() => {
    if (typeof message_ === "string")
      return stringToHex(message_);
    if (typeof message_.raw === "string")
      return message_.raw;
    return bytesToHex(message_.raw);
  })();
  const prefix2 = stringToHex(`${presignMessagePrefix}${size2(message)}`);
  return concat2([prefix2, message]);
}
__name(toPrefixedMessage, "toPrefixedMessage");

// node_modules/viem/_esm/utils/signature/hashMessage.js
function hashMessage(message, to_) {
  return keccak256(toPrefixedMessage(message), to_);
}
__name(hashMessage, "hashMessage");

// node_modules/viem/_esm/accounts/utils/signMessage.js
async function signMessage({ message, privateKey }) {
  return await sign({ hash: hashMessage(message), privateKey, to: "hex" });
}
__name(signMessage, "signMessage");

// node_modules/viem/_esm/utils/unit/Value.js
var exponents = {
  wei: 0,
  gwei: 9,
  szabo: 12,
  finney: 15,
  ether: 18
};
function format2(value, decimals = 0) {
  if (!Number.isInteger(decimals) || decimals < 0)
    throw new InvalidDecimalsError({ decimals });
  let display = value.toString();
  const negative = display.startsWith("-");
  if (negative)
    display = display.slice(1);
  display = display.padStart(decimals, "0");
  let [integer, fraction] = [
    display.slice(0, display.length - decimals),
    display.slice(display.length - decimals)
  ];
  fraction = fraction.replace(/(0+)$/, "");
  return `${negative ? "-" : ""}${integer || "0"}${fraction ? `.${fraction}` : ""}`;
}
__name(format2, "format");
function formatGwei(wei, unit = "wei") {
  return format2(wei, exponents.gwei - exponents[unit]);
}
__name(formatGwei, "formatGwei");
var InvalidDecimalsError = class extends Error {
  constructor({ decimals }) {
    super(`\`decimals\` must be a non-negative integer. Got \`${decimals}\`.`);
    Object.defineProperty(this, "name", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: "Value.InvalidDecimalsError"
    });
  }
};
__name(InvalidDecimalsError, "InvalidDecimalsError");

// node_modules/viem/_esm/utils/unit/formatGwei.js
function formatGwei2(wei, unit = "wei") {
  return formatGwei(wei, unit);
}
__name(formatGwei2, "formatGwei");

// node_modules/viem/_esm/errors/transaction.js
function prettyPrint(args) {
  const entries = Object.entries(args).map(([key, value]) => {
    if (value === void 0 || value === false)
      return null;
    return [key, value];
  }).filter(Boolean);
  const maxLength = entries.reduce((acc, [key]) => Math.max(acc, key.length), 0);
  return entries.map(([key, value]) => `  ${`${key}:`.padEnd(maxLength + 1)}  ${value}`).join("\n");
}
__name(prettyPrint, "prettyPrint");
var InvalidLegacyVError = class extends BaseError {
  constructor({ v }) {
    super(`Invalid \`v\` value "${v}". Expected 27 or 28.`, {
      name: "InvalidLegacyVError"
    });
  }
};
__name(InvalidLegacyVError, "InvalidLegacyVError");
var InvalidSerializableTransactionError = class extends BaseError {
  constructor({ transaction }) {
    super("Cannot infer a transaction type from provided transaction.", {
      metaMessages: [
        "Provided Transaction:",
        "{",
        prettyPrint(transaction),
        "}",
        "",
        "To infer the type, either provide:",
        "- a `type` to the Transaction, or",
        "- an EIP-1559 Transaction with `maxFeePerGas`, or",
        "- an EIP-2930 Transaction with `gasPrice` & `accessList`, or",
        "- an EIP-4844 Transaction with `blobs`, `blobVersionedHashes`, `sidecars`, or",
        "- an EIP-7702 Transaction with `authorizationList`, or",
        "- a Legacy Transaction with `gasPrice`"
      ],
      name: "InvalidSerializableTransactionError"
    });
  }
};
__name(InvalidSerializableTransactionError, "InvalidSerializableTransactionError");
var InvalidStorageKeySizeError = class extends BaseError {
  constructor({ storageKey }) {
    super(`Size for storage key "${storageKey}" is invalid. Expected 32 bytes. Got ${Math.floor((storageKey.length - 2) / 2)} bytes.`, { name: "InvalidStorageKeySizeError" });
  }
};
__name(InvalidStorageKeySizeError, "InvalidStorageKeySizeError");

// node_modules/viem/_esm/utils/authorization/serializeAuthorizationList.js
function serializeAuthorizationList(authorizationList) {
  if (!authorizationList || authorizationList.length === 0)
    return [];
  const serializedAuthorizationList = [];
  for (const authorization of authorizationList) {
    const { chainId, nonce, ...signature } = authorization;
    const contractAddress = authorization.address;
    serializedAuthorizationList.push([
      chainId ? toHex(chainId) : "0x",
      contractAddress,
      nonce ? toHex(nonce) : "0x",
      ...toYParitySignatureArray({}, signature)
    ]);
  }
  return serializedAuthorizationList;
}
__name(serializeAuthorizationList, "serializeAuthorizationList");

// node_modules/viem/_esm/utils/blob/blobsToCommitments.js
function blobsToCommitments(parameters) {
  const { kzg } = parameters;
  const to = parameters.to ?? (typeof parameters.blobs[0] === "string" ? "hex" : "bytes");
  const blobs = typeof parameters.blobs[0] === "string" ? parameters.blobs.map((x) => hexToBytes(x)) : parameters.blobs;
  const commitments = [];
  for (const blob of blobs)
    commitments.push(Uint8Array.from(kzg.blobToKzgCommitment(blob)));
  return to === "bytes" ? commitments : commitments.map((x) => bytesToHex(x));
}
__name(blobsToCommitments, "blobsToCommitments");

// node_modules/viem/_esm/utils/blob/blobsToProofs.js
function blobsToProofs(parameters) {
  const { kzg } = parameters;
  const to = parameters.to ?? (typeof parameters.blobs[0] === "string" ? "hex" : "bytes");
  const blobs = typeof parameters.blobs[0] === "string" ? parameters.blobs.map((x) => hexToBytes(x)) : parameters.blobs;
  const commitments = typeof parameters.commitments[0] === "string" ? parameters.commitments.map((x) => hexToBytes(x)) : parameters.commitments;
  const proofs = [];
  for (let i = 0; i < blobs.length; i++) {
    const blob = blobs[i];
    const commitment = commitments[i];
    proofs.push(Uint8Array.from(kzg.computeBlobKzgProof(blob, commitment)));
  }
  return to === "bytes" ? proofs : proofs.map((x) => bytesToHex(x));
}
__name(blobsToProofs, "blobsToProofs");

// node_modules/viem/node_modules/@noble/hashes/esm/sha256.js
var sha2563 = sha2562;

// node_modules/viem/_esm/utils/hash/sha256.js
function sha2564(value, to_) {
  const to = to_ || "hex";
  const bytes2 = sha2563(isHex(value, { strict: false }) ? toBytes3(value) : value);
  if (to === "bytes")
    return bytes2;
  return toHex(bytes2);
}
__name(sha2564, "sha256");

// node_modules/viem/_esm/utils/blob/commitmentToVersionedHash.js
function commitmentToVersionedHash(parameters) {
  const { commitment, version: version2 = 1 } = parameters;
  const to = parameters.to ?? (typeof commitment === "string" ? "hex" : "bytes");
  const versionedHash = sha2564(commitment, "bytes");
  versionedHash.set([version2], 0);
  return to === "bytes" ? versionedHash : bytesToHex(versionedHash);
}
__name(commitmentToVersionedHash, "commitmentToVersionedHash");

// node_modules/viem/_esm/utils/blob/commitmentsToVersionedHashes.js
function commitmentsToVersionedHashes(parameters) {
  const { commitments, version: version2 } = parameters;
  const to = parameters.to ?? (typeof commitments[0] === "string" ? "hex" : "bytes");
  const hashes = [];
  for (const commitment of commitments) {
    hashes.push(commitmentToVersionedHash({
      commitment,
      to,
      version: version2
    }));
  }
  return hashes;
}
__name(commitmentsToVersionedHashes, "commitmentsToVersionedHashes");

// node_modules/viem/_esm/constants/blob.js
var blobsPerTransaction = 6;
var bytesPerFieldElement = 32;
var fieldElementsPerBlob = 4096;
var bytesPerBlob = bytesPerFieldElement * fieldElementsPerBlob;
var maxBytesPerTransaction = bytesPerBlob * blobsPerTransaction - // terminator byte (0x80).
1 - // zero byte (0x00) appended to each field element.
1 * fieldElementsPerBlob * blobsPerTransaction;

// node_modules/viem/_esm/constants/kzg.js
var versionedHashVersionKzg = 1;

// node_modules/viem/_esm/errors/blob.js
var BlobSizeTooLargeError = class extends BaseError {
  constructor({ maxSize, size: size3 }) {
    super("Blob size is too large.", {
      metaMessages: [`Max: ${maxSize} bytes`, `Given: ${size3} bytes`],
      name: "BlobSizeTooLargeError"
    });
  }
};
__name(BlobSizeTooLargeError, "BlobSizeTooLargeError");
var EmptyBlobError = class extends BaseError {
  constructor() {
    super("Blob data must not be empty.", { name: "EmptyBlobError" });
  }
};
__name(EmptyBlobError, "EmptyBlobError");
var InvalidVersionedHashSizeError = class extends BaseError {
  constructor({ hash, size: size3 }) {
    super(`Versioned hash "${hash}" size is invalid.`, {
      metaMessages: ["Expected: 32", `Received: ${size3}`],
      name: "InvalidVersionedHashSizeError"
    });
  }
};
__name(InvalidVersionedHashSizeError, "InvalidVersionedHashSizeError");
var InvalidVersionedHashVersionError = class extends BaseError {
  constructor({ hash, version: version2 }) {
    super(`Versioned hash "${hash}" version is invalid.`, {
      metaMessages: [
        `Expected: ${versionedHashVersionKzg}`,
        `Received: ${version2}`
      ],
      name: "InvalidVersionedHashVersionError"
    });
  }
};
__name(InvalidVersionedHashVersionError, "InvalidVersionedHashVersionError");

// node_modules/viem/_esm/utils/blob/toBlobs.js
function toBlobs(parameters) {
  const to = parameters.to ?? (typeof parameters.data === "string" ? "hex" : "bytes");
  const data = typeof parameters.data === "string" ? hexToBytes(parameters.data) : parameters.data;
  const size_ = size2(data);
  if (!size_)
    throw new EmptyBlobError();
  if (size_ > maxBytesPerTransaction)
    throw new BlobSizeTooLargeError({
      maxSize: maxBytesPerTransaction,
      size: size_
    });
  const blobs = [];
  let active = true;
  let position = 0;
  while (active) {
    const blob = createCursor(new Uint8Array(bytesPerBlob));
    let size3 = 0;
    while (size3 < fieldElementsPerBlob) {
      const bytes2 = data.slice(position, position + (bytesPerFieldElement - 1));
      blob.pushByte(0);
      blob.pushBytes(bytes2);
      if (bytes2.length < 31) {
        blob.pushByte(128);
        active = false;
        break;
      }
      size3++;
      position += 31;
    }
    blobs.push(blob);
  }
  return to === "bytes" ? blobs.map((x) => x.bytes) : blobs.map((x) => bytesToHex(x.bytes));
}
__name(toBlobs, "toBlobs");

// node_modules/viem/_esm/utils/blob/toBlobSidecars.js
function toBlobSidecars(parameters) {
  const { data, kzg, to } = parameters;
  const blobs = parameters.blobs ?? toBlobs({ data, to });
  const commitments = parameters.commitments ?? blobsToCommitments({ blobs, kzg, to });
  const proofs = parameters.proofs ?? blobsToProofs({ blobs, commitments, kzg, to });
  const sidecars = [];
  for (let i = 0; i < blobs.length; i++)
    sidecars.push({
      blob: blobs[i],
      commitment: commitments[i],
      proof: proofs[i]
    });
  return sidecars;
}
__name(toBlobSidecars, "toBlobSidecars");

// node_modules/viem/_esm/constants/number.js
var maxInt8 = 2n ** (8n - 1n) - 1n;
var maxInt16 = 2n ** (16n - 1n) - 1n;
var maxInt24 = 2n ** (24n - 1n) - 1n;
var maxInt32 = 2n ** (32n - 1n) - 1n;
var maxInt40 = 2n ** (40n - 1n) - 1n;
var maxInt48 = 2n ** (48n - 1n) - 1n;
var maxInt56 = 2n ** (56n - 1n) - 1n;
var maxInt64 = 2n ** (64n - 1n) - 1n;
var maxInt72 = 2n ** (72n - 1n) - 1n;
var maxInt80 = 2n ** (80n - 1n) - 1n;
var maxInt88 = 2n ** (88n - 1n) - 1n;
var maxInt96 = 2n ** (96n - 1n) - 1n;
var maxInt104 = 2n ** (104n - 1n) - 1n;
var maxInt112 = 2n ** (112n - 1n) - 1n;
var maxInt120 = 2n ** (120n - 1n) - 1n;
var maxInt128 = 2n ** (128n - 1n) - 1n;
var maxInt136 = 2n ** (136n - 1n) - 1n;
var maxInt144 = 2n ** (144n - 1n) - 1n;
var maxInt152 = 2n ** (152n - 1n) - 1n;
var maxInt160 = 2n ** (160n - 1n) - 1n;
var maxInt168 = 2n ** (168n - 1n) - 1n;
var maxInt176 = 2n ** (176n - 1n) - 1n;
var maxInt184 = 2n ** (184n - 1n) - 1n;
var maxInt192 = 2n ** (192n - 1n) - 1n;
var maxInt200 = 2n ** (200n - 1n) - 1n;
var maxInt208 = 2n ** (208n - 1n) - 1n;
var maxInt216 = 2n ** (216n - 1n) - 1n;
var maxInt224 = 2n ** (224n - 1n) - 1n;
var maxInt232 = 2n ** (232n - 1n) - 1n;
var maxInt240 = 2n ** (240n - 1n) - 1n;
var maxInt248 = 2n ** (248n - 1n) - 1n;
var maxInt256 = 2n ** (256n - 1n) - 1n;
var minInt8 = -(2n ** (8n - 1n));
var minInt16 = -(2n ** (16n - 1n));
var minInt24 = -(2n ** (24n - 1n));
var minInt32 = -(2n ** (32n - 1n));
var minInt40 = -(2n ** (40n - 1n));
var minInt48 = -(2n ** (48n - 1n));
var minInt56 = -(2n ** (56n - 1n));
var minInt64 = -(2n ** (64n - 1n));
var minInt72 = -(2n ** (72n - 1n));
var minInt80 = -(2n ** (80n - 1n));
var minInt88 = -(2n ** (88n - 1n));
var minInt96 = -(2n ** (96n - 1n));
var minInt104 = -(2n ** (104n - 1n));
var minInt112 = -(2n ** (112n - 1n));
var minInt120 = -(2n ** (120n - 1n));
var minInt128 = -(2n ** (128n - 1n));
var minInt136 = -(2n ** (136n - 1n));
var minInt144 = -(2n ** (144n - 1n));
var minInt152 = -(2n ** (152n - 1n));
var minInt160 = -(2n ** (160n - 1n));
var minInt168 = -(2n ** (168n - 1n));
var minInt176 = -(2n ** (176n - 1n));
var minInt184 = -(2n ** (184n - 1n));
var minInt192 = -(2n ** (192n - 1n));
var minInt200 = -(2n ** (200n - 1n));
var minInt208 = -(2n ** (208n - 1n));
var minInt216 = -(2n ** (216n - 1n));
var minInt224 = -(2n ** (224n - 1n));
var minInt232 = -(2n ** (232n - 1n));
var minInt240 = -(2n ** (240n - 1n));
var minInt248 = -(2n ** (248n - 1n));
var minInt256 = -(2n ** (256n - 1n));
var maxUint8 = 2n ** 8n - 1n;
var maxUint16 = 2n ** 16n - 1n;
var maxUint24 = 2n ** 24n - 1n;
var maxUint32 = 2n ** 32n - 1n;
var maxUint40 = 2n ** 40n - 1n;
var maxUint48 = 2n ** 48n - 1n;
var maxUint56 = 2n ** 56n - 1n;
var maxUint64 = 2n ** 64n - 1n;
var maxUint72 = 2n ** 72n - 1n;
var maxUint80 = 2n ** 80n - 1n;
var maxUint88 = 2n ** 88n - 1n;
var maxUint96 = 2n ** 96n - 1n;
var maxUint104 = 2n ** 104n - 1n;
var maxUint112 = 2n ** 112n - 1n;
var maxUint120 = 2n ** 120n - 1n;
var maxUint128 = 2n ** 128n - 1n;
var maxUint136 = 2n ** 136n - 1n;
var maxUint144 = 2n ** 144n - 1n;
var maxUint152 = 2n ** 152n - 1n;
var maxUint160 = 2n ** 160n - 1n;
var maxUint168 = 2n ** 168n - 1n;
var maxUint176 = 2n ** 176n - 1n;
var maxUint184 = 2n ** 184n - 1n;
var maxUint192 = 2n ** 192n - 1n;
var maxUint200 = 2n ** 200n - 1n;
var maxUint208 = 2n ** 208n - 1n;
var maxUint216 = 2n ** 216n - 1n;
var maxUint224 = 2n ** 224n - 1n;
var maxUint232 = 2n ** 232n - 1n;
var maxUint240 = 2n ** 240n - 1n;
var maxUint248 = 2n ** 248n - 1n;
var maxUint256 = 2n ** 256n - 1n;

// node_modules/viem/_esm/errors/chain.js
var InvalidChainIdError = class extends BaseError {
  constructor({ chainId }) {
    super(typeof chainId === "number" ? `Chain ID "${chainId}" is invalid.` : "Chain ID is invalid.", { name: "InvalidChainIdError" });
  }
};
__name(InvalidChainIdError, "InvalidChainIdError");

// node_modules/viem/_esm/errors/node.js
var ExecutionRevertedError = class extends BaseError {
  constructor({ cause, message } = {}) {
    const reason = message?.replace("execution reverted: ", "")?.replace("execution reverted", "");
    super(`Execution reverted ${reason ? `with reason: ${reason}` : "for an unknown reason"}.`, {
      cause,
      name: "ExecutionRevertedError"
    });
  }
};
__name(ExecutionRevertedError, "ExecutionRevertedError");
Object.defineProperty(ExecutionRevertedError, "code", {
  enumerable: true,
  configurable: true,
  writable: true,
  value: 3
});
Object.defineProperty(ExecutionRevertedError, "nodeMessage", {
  enumerable: true,
  configurable: true,
  writable: true,
  value: /execution reverted|gas required exceeds allowance/
});
var FeeCapTooHighError = class extends BaseError {
  constructor({ cause, maxFeePerGas } = {}) {
    super(`The fee cap (\`maxFeePerGas\`${maxFeePerGas ? ` = ${formatGwei2(maxFeePerGas)} gwei` : ""}) cannot be higher than the maximum allowed value (2^256-1).`, {
      cause,
      name: "FeeCapTooHighError"
    });
  }
};
__name(FeeCapTooHighError, "FeeCapTooHighError");
Object.defineProperty(FeeCapTooHighError, "nodeMessage", {
  enumerable: true,
  configurable: true,
  writable: true,
  value: /max fee per gas higher than 2\^256-1|fee cap higher than 2\^256-1/
});
var FeeCapTooLowError = class extends BaseError {
  constructor({ cause, maxFeePerGas } = {}) {
    super(`The fee cap (\`maxFeePerGas\`${maxFeePerGas ? ` = ${formatGwei2(maxFeePerGas)}` : ""} gwei) cannot be lower than the block base fee.`, {
      cause,
      name: "FeeCapTooLowError"
    });
  }
};
__name(FeeCapTooLowError, "FeeCapTooLowError");
Object.defineProperty(FeeCapTooLowError, "nodeMessage", {
  enumerable: true,
  configurable: true,
  writable: true,
  value: /max fee per gas less than block base fee|fee cap less than block base fee|transaction is outdated/
});
var NonceTooHighError = class extends BaseError {
  constructor({ cause, nonce } = {}) {
    super(`Nonce provided for the transaction ${nonce ? `(${nonce}) ` : ""}is higher than the next one expected.`, { cause, name: "NonceTooHighError" });
  }
};
__name(NonceTooHighError, "NonceTooHighError");
Object.defineProperty(NonceTooHighError, "nodeMessage", {
  enumerable: true,
  configurable: true,
  writable: true,
  value: /nonce too high/
});
var NonceTooLowError = class extends BaseError {
  constructor({ cause, nonce } = {}) {
    super([
      `Nonce provided for the transaction ${nonce ? `(${nonce}) ` : ""}is lower than the current nonce of the account.`,
      "Try increasing the nonce or find the latest nonce with `getTransactionCount`."
    ].join("\n"), { cause, name: "NonceTooLowError" });
  }
};
__name(NonceTooLowError, "NonceTooLowError");
Object.defineProperty(NonceTooLowError, "nodeMessage", {
  enumerable: true,
  configurable: true,
  writable: true,
  value: /nonce too low|transaction already imported|already known/
});
var NonceMaxValueError = class extends BaseError {
  constructor({ cause, nonce } = {}) {
    super(`Nonce provided for the transaction ${nonce ? `(${nonce}) ` : ""}exceeds the maximum allowed nonce.`, { cause, name: "NonceMaxValueError" });
  }
};
__name(NonceMaxValueError, "NonceMaxValueError");
Object.defineProperty(NonceMaxValueError, "nodeMessage", {
  enumerable: true,
  configurable: true,
  writable: true,
  value: /nonce has max value/
});
var InsufficientFundsError = class extends BaseError {
  constructor({ cause } = {}) {
    super([
      "The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account."
    ].join("\n"), {
      cause,
      metaMessages: [
        "This error could arise when the account does not have enough funds to:",
        " - pay for the total gas fee,",
        " - pay for the value to send.",
        " ",
        "The cost of the transaction is calculated as `gas * gas fee + value`, where:",
        " - `gas` is the amount of gas needed for transaction to execute,",
        " - `gas fee` is the gas fee,",
        " - `value` is the amount of ether to send to the recipient."
      ],
      name: "InsufficientFundsError"
    });
  }
};
__name(InsufficientFundsError, "InsufficientFundsError");
Object.defineProperty(InsufficientFundsError, "nodeMessage", {
  enumerable: true,
  configurable: true,
  writable: true,
  value: /insufficient funds|exceeds transaction sender account balance/
});
var IntrinsicGasTooHighError = class extends BaseError {
  constructor({ cause, gas } = {}) {
    super(`The amount of gas ${gas ? `(${gas}) ` : ""}provided for the transaction exceeds the limit allowed for the block.`, {
      cause,
      name: "IntrinsicGasTooHighError"
    });
  }
};
__name(IntrinsicGasTooHighError, "IntrinsicGasTooHighError");
Object.defineProperty(IntrinsicGasTooHighError, "nodeMessage", {
  enumerable: true,
  configurable: true,
  writable: true,
  value: /intrinsic gas too high|gas limit reached/
});
var IntrinsicGasTooLowError = class extends BaseError {
  constructor({ cause, gas } = {}) {
    super(`The amount of gas ${gas ? `(${gas}) ` : ""}provided for the transaction is too low.`, {
      cause,
      name: "IntrinsicGasTooLowError"
    });
  }
};
__name(IntrinsicGasTooLowError, "IntrinsicGasTooLowError");
Object.defineProperty(IntrinsicGasTooLowError, "nodeMessage", {
  enumerable: true,
  configurable: true,
  writable: true,
  value: /intrinsic gas too low/
});
var TransactionTypeNotSupportedError = class extends BaseError {
  constructor({ cause }) {
    super("The transaction type is not supported for this chain.", {
      cause,
      name: "TransactionTypeNotSupportedError"
    });
  }
};
__name(TransactionTypeNotSupportedError, "TransactionTypeNotSupportedError");
Object.defineProperty(TransactionTypeNotSupportedError, "nodeMessage", {
  enumerable: true,
  configurable: true,
  writable: true,
  value: /transaction type not valid/
});
var TipAboveFeeCapError = class extends BaseError {
  constructor({ cause, maxPriorityFeePerGas, maxFeePerGas } = {}) {
    super([
      `The provided tip (\`maxPriorityFeePerGas\`${maxPriorityFeePerGas ? ` = ${formatGwei2(maxPriorityFeePerGas)} gwei` : ""}) cannot be higher than the fee cap (\`maxFeePerGas\`${maxFeePerGas ? ` = ${formatGwei2(maxFeePerGas)} gwei` : ""}).`
    ].join("\n"), {
      cause,
      name: "TipAboveFeeCapError"
    });
  }
};
__name(TipAboveFeeCapError, "TipAboveFeeCapError");
Object.defineProperty(TipAboveFeeCapError, "nodeMessage", {
  enumerable: true,
  configurable: true,
  writable: true,
  value: /max priority fee per gas higher than max fee per gas|tip higher than fee cap/
});

// node_modules/viem/_esm/utils/data/slice.js
function slice2(value, start, end, { strict } = {}) {
  if (isHex(value, { strict: false }))
    return sliceHex(value, start, end, {
      strict
    });
  return sliceBytes(value, start, end, {
    strict
  });
}
__name(slice2, "slice");
function assertStartOffset(value, start) {
  if (typeof start === "number" && start > 0 && start > size2(value) - 1)
    throw new SliceOffsetOutOfBoundsError({
      offset: start,
      position: "start",
      size: size2(value)
    });
}
__name(assertStartOffset, "assertStartOffset");
function assertEndOffset(value, start, end) {
  if (typeof start === "number" && typeof end === "number" && size2(value) !== end - start) {
    throw new SliceOffsetOutOfBoundsError({
      offset: end,
      position: "end",
      size: size2(value)
    });
  }
}
__name(assertEndOffset, "assertEndOffset");
function sliceBytes(value_, start, end, { strict } = {}) {
  assertStartOffset(value_, start);
  const value = value_.slice(start, end);
  if (strict)
    assertEndOffset(value, start, end);
  return value;
}
__name(sliceBytes, "sliceBytes");
function sliceHex(value_, start, end, { strict } = {}) {
  assertStartOffset(value_, start);
  const value = `0x${value_.replace("0x", "").slice((start ?? 0) * 2, (end ?? value_.length) * 2)}`;
  if (strict)
    assertEndOffset(value, start, end);
  return value;
}
__name(sliceHex, "sliceHex");

// node_modules/viem/_esm/utils/transaction/assertTransaction.js
function assertTransactionEIP7702(transaction) {
  const { authorizationList } = transaction;
  if (authorizationList) {
    for (const authorization of authorizationList) {
      const { chainId } = authorization;
      const address = authorization.address;
      if (!isAddress(address))
        throw new InvalidAddressError({ address });
      if (chainId < 0)
        throw new InvalidChainIdError({ chainId });
    }
  }
  assertTransactionEIP1559(transaction);
}
__name(assertTransactionEIP7702, "assertTransactionEIP7702");
function assertTransactionEIP4844(transaction) {
  const { blobVersionedHashes } = transaction;
  if (blobVersionedHashes) {
    if (blobVersionedHashes.length === 0)
      throw new EmptyBlobError();
    for (const hash of blobVersionedHashes) {
      const size_ = size2(hash);
      const version2 = hexToNumber(slice2(hash, 0, 1));
      if (size_ !== 32)
        throw new InvalidVersionedHashSizeError({ hash, size: size_ });
      if (version2 !== versionedHashVersionKzg)
        throw new InvalidVersionedHashVersionError({
          hash,
          version: version2
        });
    }
  }
  assertTransactionEIP1559(transaction);
}
__name(assertTransactionEIP4844, "assertTransactionEIP4844");
function assertTransactionEIP1559(transaction) {
  const { chainId, maxPriorityFeePerGas, maxFeePerGas, to } = transaction;
  if (chainId <= 0)
    throw new InvalidChainIdError({ chainId });
  if (to && !isAddress(to))
    throw new InvalidAddressError({ address: to });
  if (maxFeePerGas && maxFeePerGas > maxUint256)
    throw new FeeCapTooHighError({ maxFeePerGas });
  if (maxPriorityFeePerGas && maxFeePerGas && maxPriorityFeePerGas > maxFeePerGas)
    throw new TipAboveFeeCapError({ maxFeePerGas, maxPriorityFeePerGas });
}
__name(assertTransactionEIP1559, "assertTransactionEIP1559");
function assertTransactionEIP2930(transaction) {
  const { chainId, maxPriorityFeePerGas, gasPrice, maxFeePerGas, to } = transaction;
  if (chainId <= 0)
    throw new InvalidChainIdError({ chainId });
  if (to && !isAddress(to))
    throw new InvalidAddressError({ address: to });
  if (maxPriorityFeePerGas || maxFeePerGas)
    throw new BaseError("`maxFeePerGas`/`maxPriorityFeePerGas` is not a valid EIP-2930 Transaction attribute.");
  if (gasPrice && gasPrice > maxUint256)
    throw new FeeCapTooHighError({ maxFeePerGas: gasPrice });
}
__name(assertTransactionEIP2930, "assertTransactionEIP2930");
function assertTransactionLegacy(transaction) {
  const { chainId, maxPriorityFeePerGas, gasPrice, maxFeePerGas, to } = transaction;
  if (to && !isAddress(to))
    throw new InvalidAddressError({ address: to });
  if (typeof chainId !== "undefined" && chainId <= 0)
    throw new InvalidChainIdError({ chainId });
  if (maxPriorityFeePerGas || maxFeePerGas)
    throw new BaseError("`maxFeePerGas`/`maxPriorityFeePerGas` is not a valid Legacy Transaction attribute.");
  if (gasPrice && gasPrice > maxUint256)
    throw new FeeCapTooHighError({ maxFeePerGas: gasPrice });
}
__name(assertTransactionLegacy, "assertTransactionLegacy");

// node_modules/viem/_esm/utils/transaction/getTransactionType.js
function getTransactionType(transaction) {
  if (transaction.type)
    return transaction.type;
  if (typeof transaction.authorizationList !== "undefined")
    return "eip7702";
  if (typeof transaction.blobs !== "undefined" || typeof transaction.blobVersionedHashes !== "undefined" || typeof transaction.maxFeePerBlobGas !== "undefined" || typeof transaction.sidecars !== "undefined")
    return "eip4844";
  if (typeof transaction.maxFeePerGas !== "undefined" || typeof transaction.maxPriorityFeePerGas !== "undefined") {
    return "eip1559";
  }
  if (typeof transaction.gasPrice !== "undefined") {
    if (typeof transaction.accessList !== "undefined")
      return "eip2930";
    return "legacy";
  }
  throw new InvalidSerializableTransactionError({ transaction });
}
__name(getTransactionType, "getTransactionType");

// node_modules/viem/_esm/utils/transaction/serializeAccessList.js
function serializeAccessList(accessList) {
  if (!accessList || accessList.length === 0)
    return [];
  const serializedAccessList = [];
  for (let i = 0; i < accessList.length; i++) {
    const { address, storageKeys } = accessList[i];
    for (let j = 0; j < storageKeys.length; j++) {
      if (storageKeys[j].length - 2 !== 64) {
        throw new InvalidStorageKeySizeError({ storageKey: storageKeys[j] });
      }
    }
    if (!isAddress(address, { strict: false })) {
      throw new InvalidAddressError({ address });
    }
    serializedAccessList.push([address, storageKeys]);
  }
  return serializedAccessList;
}
__name(serializeAccessList, "serializeAccessList");

// node_modules/viem/_esm/utils/transaction/serializeTransaction.js
function serializeTransaction(transaction, signature) {
  const type = getTransactionType(transaction);
  if (type === "eip1559")
    return serializeTransactionEIP1559(transaction, signature);
  if (type === "eip2930")
    return serializeTransactionEIP2930(transaction, signature);
  if (type === "eip4844")
    return serializeTransactionEIP4844(transaction, signature);
  if (type === "eip7702")
    return serializeTransactionEIP7702(transaction, signature);
  return serializeTransactionLegacy(transaction, signature);
}
__name(serializeTransaction, "serializeTransaction");
function serializeTransactionEIP7702(transaction, signature) {
  const { authorizationList, chainId, gas, nonce, to, value, maxFeePerGas, maxPriorityFeePerGas, accessList, data } = transaction;
  assertTransactionEIP7702(transaction);
  const serializedAccessList = serializeAccessList(accessList);
  const serializedAuthorizationList = serializeAuthorizationList(authorizationList);
  return concatHex([
    "0x04",
    toRlp([
      numberToHex(chainId),
      nonce ? numberToHex(nonce) : "0x",
      maxPriorityFeePerGas ? numberToHex(maxPriorityFeePerGas) : "0x",
      maxFeePerGas ? numberToHex(maxFeePerGas) : "0x",
      gas ? numberToHex(gas) : "0x",
      to ?? "0x",
      value ? numberToHex(value) : "0x",
      data ?? "0x",
      serializedAccessList,
      serializedAuthorizationList,
      ...toYParitySignatureArray(transaction, signature)
    ])
  ]);
}
__name(serializeTransactionEIP7702, "serializeTransactionEIP7702");
function serializeTransactionEIP4844(transaction, signature) {
  const { chainId, gas, nonce, to, value, maxFeePerBlobGas, maxFeePerGas, maxPriorityFeePerGas, accessList, data } = transaction;
  assertTransactionEIP4844(transaction);
  let blobVersionedHashes = transaction.blobVersionedHashes;
  let sidecars = transaction.sidecars;
  if (transaction.blobs && (typeof blobVersionedHashes === "undefined" || typeof sidecars === "undefined")) {
    const blobs2 = typeof transaction.blobs[0] === "string" ? transaction.blobs : transaction.blobs.map((x) => bytesToHex(x));
    const kzg = transaction.kzg;
    const commitments2 = blobsToCommitments({
      blobs: blobs2,
      kzg
    });
    if (typeof blobVersionedHashes === "undefined")
      blobVersionedHashes = commitmentsToVersionedHashes({
        commitments: commitments2
      });
    if (typeof sidecars === "undefined") {
      const proofs2 = blobsToProofs({ blobs: blobs2, commitments: commitments2, kzg });
      sidecars = toBlobSidecars({ blobs: blobs2, commitments: commitments2, proofs: proofs2 });
    }
  }
  const serializedAccessList = serializeAccessList(accessList);
  const serializedTransaction = [
    numberToHex(chainId),
    nonce ? numberToHex(nonce) : "0x",
    maxPriorityFeePerGas ? numberToHex(maxPriorityFeePerGas) : "0x",
    maxFeePerGas ? numberToHex(maxFeePerGas) : "0x",
    gas ? numberToHex(gas) : "0x",
    to ?? "0x",
    value ? numberToHex(value) : "0x",
    data ?? "0x",
    serializedAccessList,
    maxFeePerBlobGas ? numberToHex(maxFeePerBlobGas) : "0x",
    blobVersionedHashes ?? [],
    ...toYParitySignatureArray(transaction, signature)
  ];
  const blobs = [];
  const commitments = [];
  const proofs = [];
  if (sidecars)
    for (let i = 0; i < sidecars.length; i++) {
      const { blob, commitment, proof } = sidecars[i];
      blobs.push(blob);
      commitments.push(commitment);
      proofs.push(proof);
    }
  return concatHex([
    "0x03",
    sidecars ? (
      // If sidecars are enabled, envelope turns into a "wrapper":
      toRlp([serializedTransaction, blobs, commitments, proofs])
    ) : (
      // If sidecars are disabled, standard envelope is used:
      toRlp(serializedTransaction)
    )
  ]);
}
__name(serializeTransactionEIP4844, "serializeTransactionEIP4844");
function serializeTransactionEIP1559(transaction, signature) {
  const { chainId, gas, nonce, to, value, maxFeePerGas, maxPriorityFeePerGas, accessList, data } = transaction;
  assertTransactionEIP1559(transaction);
  const serializedAccessList = serializeAccessList(accessList);
  const serializedTransaction = [
    numberToHex(chainId),
    nonce ? numberToHex(nonce) : "0x",
    maxPriorityFeePerGas ? numberToHex(maxPriorityFeePerGas) : "0x",
    maxFeePerGas ? numberToHex(maxFeePerGas) : "0x",
    gas ? numberToHex(gas) : "0x",
    to ?? "0x",
    value ? numberToHex(value) : "0x",
    data ?? "0x",
    serializedAccessList,
    ...toYParitySignatureArray(transaction, signature)
  ];
  return concatHex([
    "0x02",
    toRlp(serializedTransaction)
  ]);
}
__name(serializeTransactionEIP1559, "serializeTransactionEIP1559");
function serializeTransactionEIP2930(transaction, signature) {
  const { chainId, gas, data, nonce, to, value, accessList, gasPrice } = transaction;
  assertTransactionEIP2930(transaction);
  const serializedAccessList = serializeAccessList(accessList);
  const serializedTransaction = [
    numberToHex(chainId),
    nonce ? numberToHex(nonce) : "0x",
    gasPrice ? numberToHex(gasPrice) : "0x",
    gas ? numberToHex(gas) : "0x",
    to ?? "0x",
    value ? numberToHex(value) : "0x",
    data ?? "0x",
    serializedAccessList,
    ...toYParitySignatureArray(transaction, signature)
  ];
  return concatHex([
    "0x01",
    toRlp(serializedTransaction)
  ]);
}
__name(serializeTransactionEIP2930, "serializeTransactionEIP2930");
function serializeTransactionLegacy(transaction, signature) {
  const { chainId = 0, gas, data, nonce, to, value, gasPrice } = transaction;
  assertTransactionLegacy(transaction);
  let serializedTransaction = [
    nonce ? numberToHex(nonce) : "0x",
    gasPrice ? numberToHex(gasPrice) : "0x",
    gas ? numberToHex(gas) : "0x",
    to ?? "0x",
    value ? numberToHex(value) : "0x",
    data ?? "0x"
  ];
  if (signature) {
    const v = (() => {
      if (signature.v >= 35n) {
        const inferredChainId = (signature.v - 35n) / 2n;
        if (inferredChainId > 0)
          return signature.v;
        return 27n + (signature.v === 35n ? 0n : 1n);
      }
      if (chainId > 0)
        return BigInt(chainId * 2) + BigInt(35n + signature.v - 27n);
      const v2 = 27n + (signature.v === 27n ? 0n : 1n);
      if (signature.v !== v2)
        throw new InvalidLegacyVError({ v: signature.v });
      return v2;
    })();
    const r = trim(signature.r);
    const s = trim(signature.s);
    serializedTransaction = [
      ...serializedTransaction,
      numberToHex(v),
      r === "0x00" ? "0x" : r,
      s === "0x00" ? "0x" : s
    ];
  } else if (chainId > 0) {
    serializedTransaction = [
      ...serializedTransaction,
      numberToHex(chainId),
      "0x",
      "0x"
    ];
  }
  return toRlp(serializedTransaction);
}
__name(serializeTransactionLegacy, "serializeTransactionLegacy");
function toYParitySignatureArray(transaction, signature_) {
  const signature = signature_ ?? transaction;
  const { v, yParity } = signature;
  if (typeof signature.r === "undefined")
    return [];
  if (typeof signature.s === "undefined")
    return [];
  if (typeof v === "undefined" && typeof yParity === "undefined")
    return [];
  const r = trim(signature.r);
  const s = trim(signature.s);
  const yParity_ = (() => {
    if (typeof yParity === "number")
      return yParity ? numberToHex(1) : "0x";
    if (v === 0n)
      return "0x";
    if (v === 1n)
      return numberToHex(1);
    return v === 27n ? "0x" : numberToHex(1);
  })();
  return [yParity_, r === "0x00" ? "0x" : r, s === "0x00" ? "0x" : s];
}
__name(toYParitySignatureArray, "toYParitySignatureArray");

// node_modules/viem/_esm/accounts/utils/signTransaction.js
async function signTransaction(parameters) {
  const { privateKey, transaction, serializer = serializeTransaction } = parameters;
  const signableTransaction = (() => {
    if (transaction.type === "eip4844")
      return {
        ...transaction,
        sidecars: false
      };
    return transaction;
  })();
  const signature = await sign({
    hash: keccak256(await serializer(signableTransaction)),
    privateKey
  });
  return await serializer(transaction, signature);
}
__name(signTransaction, "signTransaction");

// node_modules/viem/_esm/errors/abi.js
var AbiEncodingArrayLengthMismatchError = class extends BaseError {
  constructor({ expectedLength, givenLength, type }) {
    super([
      `ABI encoding array length mismatch for type ${type}.`,
      `Expected length: ${expectedLength}`,
      `Given length: ${givenLength}`
    ].join("\n"), { name: "AbiEncodingArrayLengthMismatchError" });
  }
};
__name(AbiEncodingArrayLengthMismatchError, "AbiEncodingArrayLengthMismatchError");
var AbiEncodingBytesSizeMismatchError = class extends BaseError {
  constructor({ expectedSize, value }) {
    super(`Size of bytes "${value}" (bytes${size2(value)}) does not match expected size (bytes${expectedSize}).`, { name: "AbiEncodingBytesSizeMismatchError" });
  }
};
__name(AbiEncodingBytesSizeMismatchError, "AbiEncodingBytesSizeMismatchError");
var AbiEncodingLengthMismatchError = class extends BaseError {
  constructor({ expectedLength, givenLength }) {
    super([
      "ABI encoding params/values length mismatch.",
      `Expected length (params): ${expectedLength}`,
      `Given length (values): ${givenLength}`
    ].join("\n"), { name: "AbiEncodingLengthMismatchError" });
  }
};
__name(AbiEncodingLengthMismatchError, "AbiEncodingLengthMismatchError");
var BytesSizeMismatchError = class extends BaseError {
  constructor({ expectedSize, givenSize }) {
    super(`Expected bytes${expectedSize}, got bytes${givenSize}.`, {
      name: "BytesSizeMismatchError"
    });
  }
};
__name(BytesSizeMismatchError, "BytesSizeMismatchError");
var InvalidAbiEncodingTypeError = class extends BaseError {
  constructor(type, { docsPath }) {
    super([
      `Type "${type}" is not a valid encoding type.`,
      "Please provide a valid ABI type."
    ].join("\n"), { docsPath, name: "InvalidAbiEncodingType" });
  }
};
__name(InvalidAbiEncodingTypeError, "InvalidAbiEncodingTypeError");
var InvalidArrayError = class extends BaseError {
  constructor(value) {
    super([`Value "${value}" is not a valid array.`].join("\n"), {
      name: "InvalidArrayError"
    });
  }
};
__name(InvalidArrayError, "InvalidArrayError");

// node_modules/viem/_esm/utils/regex.js
var bytesRegex = /^bytes([1-9]|1[0-9]|2[0-9]|3[0-2])?$/;
var integerRegex = /^(u?int)(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?$/;

// node_modules/viem/_esm/utils/abi/encodeAbiParameters.js
function encodeAbiParameters(params, values) {
  if (params.length !== values.length)
    throw new AbiEncodingLengthMismatchError({
      expectedLength: params.length,
      givenLength: values.length
    });
  const preparedParams = prepareParams({
    params,
    values
  });
  return encodeParams(preparedParams);
}
__name(encodeAbiParameters, "encodeAbiParameters");
function prepareParams({ params, values }) {
  const preparedParams = [];
  for (let i = 0; i < params.length; i++) {
    preparedParams.push(prepareParam({ param: params[i], value: values[i] }));
  }
  return preparedParams;
}
__name(prepareParams, "prepareParams");
function prepareParam({ param, value }) {
  const arrayComponents = getArrayComponents(param.type);
  if (arrayComponents) {
    const [length2, type] = arrayComponents;
    return encodeArray2(value, { length: length2, param: { ...param, type } });
  }
  if (param.type === "tuple") {
    return encodeTuple(value, {
      param
    });
  }
  if (param.type === "address") {
    return encodeAddress(value);
  }
  if (param.type === "bool") {
    return encodeBool(value);
  }
  if (param.type.startsWith("uint") || param.type.startsWith("int")) {
    const signed = param.type.startsWith("int");
    const [, , size3 = "256"] = integerRegex.exec(param.type) ?? [];
    return encodeNumber(value, {
      signed,
      size: Number(size3)
    });
  }
  if (param.type.startsWith("bytes")) {
    return encodeBytes2(value, { param });
  }
  if (param.type === "string") {
    return encodeString2(value);
  }
  throw new InvalidAbiEncodingTypeError(param.type, {
    docsPath: "/docs/contract/encodeAbiParameters"
  });
}
__name(prepareParam, "prepareParam");
function encodeParams(preparedParams) {
  let staticSize = 0;
  for (let i = 0; i < preparedParams.length; i++) {
    const { dynamic, encoded } = preparedParams[i];
    if (dynamic)
      staticSize += 32;
    else
      staticSize += size2(encoded);
  }
  const staticParams = [];
  const dynamicParams = [];
  let dynamicSize = 0;
  for (let i = 0; i < preparedParams.length; i++) {
    const { dynamic, encoded } = preparedParams[i];
    if (dynamic) {
      staticParams.push(numberToHex(staticSize + dynamicSize, { size: 32 }));
      dynamicParams.push(encoded);
      dynamicSize += size2(encoded);
    } else {
      staticParams.push(encoded);
    }
  }
  return concatHex([...staticParams, ...dynamicParams]);
}
__name(encodeParams, "encodeParams");
function encodeAddress(value) {
  if (!isAddress(value))
    throw new InvalidAddressError({ address: value });
  return { dynamic: false, encoded: padHex(value.toLowerCase()) };
}
__name(encodeAddress, "encodeAddress");
function encodeArray2(value, { length: length2, param }) {
  const dynamic = length2 === null;
  if (!Array.isArray(value))
    throw new InvalidArrayError(value);
  if (!dynamic && value.length !== length2)
    throw new AbiEncodingArrayLengthMismatchError({
      expectedLength: length2,
      givenLength: value.length,
      type: `${param.type}[${length2}]`
    });
  let dynamicChild = value.length === 0 && isDynamicType(param);
  const preparedParams = [];
  for (let i = 0; i < value.length; i++) {
    const preparedParam = prepareParam({ param, value: value[i] });
    if (preparedParam.dynamic)
      dynamicChild = true;
    preparedParams.push(preparedParam);
  }
  if (dynamic || dynamicChild) {
    const data = encodeParams(preparedParams);
    if (dynamic) {
      const length3 = numberToHex(preparedParams.length, { size: 32 });
      return {
        dynamic: true,
        encoded: concatHex([length3, data])
      };
    }
    if (dynamicChild)
      return { dynamic: true, encoded: data };
  }
  return {
    dynamic: false,
    encoded: concatHex(preparedParams.map(({ encoded }) => encoded))
  };
}
__name(encodeArray2, "encodeArray");
function encodeBytes2(value, { param }) {
  const [, paramSize] = param.type.split("bytes");
  const bytesSize = size2(value);
  if (!paramSize) {
    let value_ = value;
    if (bytesSize % 32 !== 0)
      value_ = padHex(value_, {
        dir: "right",
        size: Math.ceil((value.length - 2) / 2 / 32) * 32
      });
    return {
      dynamic: true,
      encoded: concatHex([
        padHex(numberToHex(bytesSize, { size: 32 })),
        value_
      ])
    };
  }
  if (bytesSize !== Number.parseInt(paramSize, 10))
    throw new AbiEncodingBytesSizeMismatchError({
      expectedSize: Number.parseInt(paramSize, 10),
      value
    });
  return { dynamic: false, encoded: padHex(value, { dir: "right" }) };
}
__name(encodeBytes2, "encodeBytes");
function encodeBool(value) {
  if (typeof value !== "boolean")
    throw new BaseError(`Invalid boolean value: "${value}" (type: ${typeof value}). Expected: \`true\` or \`false\`.`);
  return { dynamic: false, encoded: padHex(boolToHex(value)) };
}
__name(encodeBool, "encodeBool");
function encodeNumber(value, { signed, size: size3 = 256 }) {
  if (typeof size3 === "number") {
    const max = 2n ** (BigInt(size3) - (signed ? 1n : 0n)) - 1n;
    const min = signed ? -max - 1n : 0n;
    if (value > max || value < min)
      throw new IntegerOutOfRangeError({
        max: max.toString(),
        min: min.toString(),
        signed,
        size: size3 / 8,
        value: value.toString()
      });
  }
  return {
    dynamic: false,
    encoded: numberToHex(value, {
      size: 32,
      signed
    })
  };
}
__name(encodeNumber, "encodeNumber");
function encodeString2(value) {
  const hexValue = stringToHex(value);
  const partsLength = Math.ceil(size2(hexValue) / 32);
  const parts = [];
  for (let i = 0; i < partsLength; i++) {
    parts.push(padHex(slice2(hexValue, i * 32, (i + 1) * 32), {
      dir: "right"
    }));
  }
  return {
    dynamic: true,
    encoded: concatHex([
      padHex(numberToHex(size2(hexValue), { size: 32 })),
      ...parts
    ])
  };
}
__name(encodeString2, "encodeString");
function encodeTuple(value, { param }) {
  let dynamic = false;
  const preparedParams = [];
  for (let i = 0; i < param.components.length; i++) {
    const param_ = param.components[i];
    const index2 = Array.isArray(value) ? i : param_.name;
    const preparedParam = prepareParam({
      param: param_,
      value: value[index2]
    });
    preparedParams.push(preparedParam);
    if (preparedParam.dynamic)
      dynamic = true;
  }
  return {
    dynamic,
    encoded: dynamic ? encodeParams(preparedParams) : concatHex(preparedParams.map(({ encoded }) => encoded))
  };
}
__name(encodeTuple, "encodeTuple");
function getArrayComponents(type) {
  const matches = type.match(/^(.*)\[(\d+)?\]$/);
  return matches ? (
    // Return `null` if the array is dynamic.
    [matches[2] ? Number(matches[2]) : null, matches[1]]
  ) : void 0;
}
__name(getArrayComponents, "getArrayComponents");
function isDynamicType(param) {
  const { type } = param;
  if (type === "string")
    return true;
  if (type === "bytes")
    return true;
  if (type.endsWith("[]"))
    return true;
  if (type === "tuple")
    return param.components.some(isDynamicType);
  const arrayComponents = getArrayComponents(type);
  if (arrayComponents)
    return isDynamicType({ ...param, type: arrayComponents[1] });
  return false;
}
__name(isDynamicType, "isDynamicType");

// node_modules/viem/_esm/utils/stringify.js
var stringify = /* @__PURE__ */ __name((value, replacer, space) => JSON.stringify(value, (key, value_) => {
  const value2 = typeof value_ === "bigint" ? value_.toString() : value_;
  return typeof replacer === "function" ? replacer(key, value2) : value2;
}, space), "stringify");

// node_modules/viem/_esm/errors/typedData.js
var InvalidDomainError = class extends BaseError {
  constructor({ domain }) {
    super(`Invalid domain "${stringify(domain)}".`, {
      metaMessages: ["Must be a valid EIP-712 domain."]
    });
  }
};
__name(InvalidDomainError, "InvalidDomainError");
var InvalidPrimaryTypeError = class extends BaseError {
  constructor({ primaryType, types }) {
    super(`Invalid primary type \`${primaryType}\` must be one of \`${JSON.stringify(Object.keys(types))}\`.`, {
      docsPath: "/api/glossary/Errors#typeddatainvalidprimarytypeerror",
      metaMessages: ["Check that the primary type is a key in `types`."]
    });
  }
};
__name(InvalidPrimaryTypeError, "InvalidPrimaryTypeError");
var InvalidStructTypeError = class extends BaseError {
  constructor({ type }) {
    super(`Struct type "${type}" is invalid.`, {
      metaMessages: ["Struct type must not be a Solidity type."],
      name: "InvalidStructTypeError"
    });
  }
};
__name(InvalidStructTypeError, "InvalidStructTypeError");
var InvalidTypedDataTypeError = class extends BaseError {
  constructor({ type }) {
    const canonicalType = type.replace(/^(u?int)/, "$&256");
    super(`Type "${type}" is not a valid EIP-712 type.`, {
      metaMessages: [`Use "${canonicalType}" instead.`],
      name: "InvalidTypedDataTypeError"
    });
  }
};
__name(InvalidTypedDataTypeError, "InvalidTypedDataTypeError");

// node_modules/viem/_esm/utils/typedData.js
function validateTypedData(parameters) {
  const { domain, message, primaryType, types } = parameters;
  const validateData = /* @__PURE__ */ __name((struct, data) => {
    for (const param of struct) {
      const { name: name5, type } = param;
      const value = data[name5];
      const baseType = type.replace(/(\[[0-9]*\])+$/, "");
      if (baseType === "int" || baseType === "uint")
        throw new InvalidTypedDataTypeError({ type });
      const integerMatch = type.match(integerRegex);
      if (integerMatch && (typeof value === "number" || typeof value === "bigint")) {
        const [_type, base2, size_] = integerMatch;
        numberToHex(value, {
          signed: base2 === "int",
          size: Number.parseInt(size_, 10) / 8
        });
      }
      if (type === "address" && typeof value === "string" && !isAddress(value))
        throw new InvalidAddressError({ address: value });
      const bytesMatch = type.match(bytesRegex);
      if (bytesMatch) {
        const [_type, size_] = bytesMatch;
        if (size_ && size2(value) !== Number.parseInt(size_, 10))
          throw new BytesSizeMismatchError({
            expectedSize: Number.parseInt(size_, 10),
            givenSize: size2(value)
          });
      }
      const struct2 = types[type];
      if (struct2) {
        validateReference(type);
        validateData(struct2, value);
      }
    }
  }, "validateData");
  if (types.EIP712Domain && domain) {
    if (typeof domain !== "object")
      throw new InvalidDomainError({ domain });
    validateData(types.EIP712Domain, domain);
  }
  if (primaryType !== "EIP712Domain") {
    if (types[primaryType])
      validateData(types[primaryType], message);
    else
      throw new InvalidPrimaryTypeError({ primaryType, types });
  }
}
__name(validateTypedData, "validateTypedData");
function getTypesForEIP712Domain({ domain }) {
  return [
    typeof domain?.name === "string" && { name: "name", type: "string" },
    domain?.version && { name: "version", type: "string" },
    (typeof domain?.chainId === "number" || typeof domain?.chainId === "bigint") && {
      name: "chainId",
      type: "uint256"
    },
    domain?.verifyingContract && {
      name: "verifyingContract",
      type: "address"
    },
    domain?.salt && { name: "salt", type: "bytes32" }
  ].filter(Boolean);
}
__name(getTypesForEIP712Domain, "getTypesForEIP712Domain");
function validateReference(type) {
  if (type === "address" || type === "bool" || type === "string" || type.startsWith("bytes") || type.startsWith("uint") || type.startsWith("int"))
    throw new InvalidStructTypeError({ type });
}
__name(validateReference, "validateReference");

// node_modules/viem/_esm/utils/signature/hashTypedData.js
function hashTypedData(parameters) {
  const { domain = {}, message, primaryType } = parameters;
  const types = {
    EIP712Domain: getTypesForEIP712Domain({ domain }),
    ...parameters.types
  };
  validateTypedData({
    domain,
    message,
    primaryType,
    types
  });
  const parts = ["0x1901"];
  if (domain)
    parts.push(hashDomain({
      domain,
      types
    }));
  if (primaryType !== "EIP712Domain")
    parts.push(hashStruct({
      data: message,
      primaryType,
      types
    }));
  return keccak256(concat2(parts));
}
__name(hashTypedData, "hashTypedData");
function hashDomain({ domain, types }) {
  return hashStruct({
    data: domain,
    primaryType: "EIP712Domain",
    types
  });
}
__name(hashDomain, "hashDomain");
function hashStruct({ data, primaryType, types }) {
  const encoded = encodeData({
    data,
    primaryType,
    types
  });
  return keccak256(encoded);
}
__name(hashStruct, "hashStruct");
function encodeData({ data, primaryType, types }) {
  const encodedTypes = [{ type: "bytes32" }];
  const encodedValues = [hashType({ primaryType, types })];
  for (const field of types[primaryType]) {
    const [type, value] = encodeField({
      types,
      name: field.name,
      type: field.type,
      value: data[field.name]
    });
    encodedTypes.push(type);
    encodedValues.push(value);
  }
  return encodeAbiParameters(encodedTypes, encodedValues);
}
__name(encodeData, "encodeData");
function hashType({ primaryType, types }) {
  const encodedHashType = toHex(encodeType({ primaryType, types }));
  return keccak256(encodedHashType);
}
__name(hashType, "hashType");
function encodeType({ primaryType, types }) {
  let result = "";
  const unsortedDeps = findTypeDependencies({ primaryType, types });
  unsortedDeps.delete(primaryType);
  const deps = [primaryType, ...Array.from(unsortedDeps).sort()];
  for (const type of deps) {
    result += `${type}(${types[type].map(({ name: name5, type: t }) => `${t} ${name5}`).join(",")})`;
  }
  return result;
}
__name(encodeType, "encodeType");
function findTypeDependencies({ primaryType: primaryType_, types }, results = /* @__PURE__ */ new Set()) {
  const match = primaryType_.match(/^\w*/u);
  const primaryType = match?.[0];
  if (results.has(primaryType) || types[primaryType] === void 0) {
    return results;
  }
  results.add(primaryType);
  for (const field of types[primaryType]) {
    findTypeDependencies({ primaryType: field.type, types }, results);
  }
  return results;
}
__name(findTypeDependencies, "findTypeDependencies");
function encodeField({ types, name: name5, type, value }) {
  if (types[type] !== void 0) {
    return [
      { type: "bytes32" },
      keccak256(encodeData({ data: value, primaryType: type, types }))
    ];
  }
  if (type === "bytes")
    return [{ type: "bytes32" }, keccak256(value)];
  if (type === "string")
    return [{ type: "bytes32" }, keccak256(toHex(value))];
  if (type.lastIndexOf("]") === type.length - 1) {
    const parsedType = type.slice(0, type.lastIndexOf("["));
    const typeValuePairs = value.map((item) => encodeField({
      name: name5,
      type: parsedType,
      types,
      value: item
    }));
    return [
      { type: "bytes32" },
      keccak256(encodeAbiParameters(typeValuePairs.map(([t]) => t), typeValuePairs.map(([, v]) => v)))
    ];
  }
  return [{ type }, value];
}
__name(encodeField, "encodeField");

// node_modules/viem/_esm/accounts/utils/signTypedData.js
async function signTypedData(parameters) {
  const { privateKey, ...typedData } = parameters;
  return await sign({
    hash: hashTypedData(typedData),
    privateKey,
    to: "hex"
  });
}
__name(signTypedData, "signTypedData");

// node_modules/viem/_esm/accounts/privateKeyToAccount.js
function privateKeyToAccount(privateKey, options = {}) {
  const { nonceManager } = options;
  const publicKey = toHex(secp256k1.getPublicKey(privateKey.slice(2), false));
  const address = publicKeyToAddress(publicKey);
  const account = toAccount({
    address,
    nonceManager,
    async sign({ hash }) {
      return sign({ hash, privateKey, to: "hex" });
    },
    async signAuthorization(authorization) {
      return signAuthorization({ ...authorization, privateKey });
    },
    async signMessage({ message }) {
      return signMessage({ message, privateKey });
    },
    async signTransaction(transaction, { serializer } = {}) {
      return signTransaction({ privateKey, transaction, serializer });
    },
    async signTypedData(typedData) {
      return signTypedData({ ...typedData, privateKey });
    }
  });
  return {
    ...account,
    publicKey,
    source: "privateKey"
  };
}
__name(privateKeyToAccount, "privateKeyToAccount");

// src/pdp.ts
var PDPClient = class {
  options;
  synapse;
  wantPrivateKey;
  sourceTag;
  constructor(options) {
    this.options = options;
    if (options.privateKeyHex) {
      const key = options.privateKeyHex.startsWith("0x") ? options.privateKeyHex : `0x${options.privateKeyHex}`;
      this.wantPrivateKey = key;
      this.sourceTag = options.sourceTag ?? "openscion-poc-worker";
    }
  }
  async computeCommP(input) {
    if (input.bytesBase64) {
      const data = decodeBase64(input.bytesBase64);
      const piece = piece_exports.fromPayload(data);
      return { pieceCid: piece.link.toString() };
    }
    if (input.contentUrl) {
      const resp = await fetch(input.contentUrl);
      if (!resp.ok)
        throw new Error(`fetch failed: ${resp.status}`);
      const buf = new Uint8Array(await resp.arrayBuffer());
      const piece = piece_exports.fromPayload(buf);
      return { pieceCid: piece.link.toString() };
    }
    if (typeof input.sizeBytes === "number") {
      const pieceCid = await fakePieceCid(String(input.sizeBytes));
      return { pieceCid };
    }
    throw new Error("no input provided to compute CommP");
  }
  async storePiece(input) {
    if (input.bytesBase64) {
      if (!this.synapse && this.wantPrivateKey) {
        await this.ensureSdk();
      }
    }
    if (this.synapse && input.bytesBase64) {
      try {
        const data = decodeBase64(input.bytesBase64);
        const result = await this.synapse.storage.upload(data);
        return {
          dealId: void 0,
          providerId: input.providerId ?? this.options.defaultProviderId,
          state: result.complete ? "complete" : "storing"
        };
      } catch (e) {
        return {
          providerId: input.providerId ?? this.options.defaultProviderId,
          state: "error",
          error: e.message
        };
      }
    }
    return {
      dealId: void 0,
      providerId: input.providerId ?? this.options.defaultProviderId,
      state: "queued"
    };
  }
  async downloadPiece(pieceCid) {
    if (!this.synapse) {
      throw new Error("Synapse not configured");
    }
    return await this.synapse.storage.download({ pieceCid });
  }
  async ensureSdk() {
    if (this.synapse || !this.wantPrivateKey)
      return;
    const sdkName = ["@filoz", "synapse-sdk"].join("/");
    const mod2 = await import(sdkName).catch(() => {
      throw new Error("Synapse SDK is not available in this build");
    });
    const account = privateKeyToAccount(this.wantPrivateKey);
    this.synapse = mod2.Synapse.create({
      account,
      source: this.sourceTag ?? "openscion-poc-worker"
    });
  }
};
__name(PDPClient, "PDPClient");
function decodeBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++)
    out[i] = bin.charCodeAt(i);
  return out;
}
__name(decodeBase64, "decodeBase64");
async function fakePieceCid(seed) {
  const data = new TextEncoder().encode(seed);
  if (!(typeof globalThis !== "undefined" && typeof globalThis.crypto !== "undefined" && globalThis.crypto.subtle && typeof globalThis.crypto.subtle.digest === "function")) {
    throw new Error("SubtleCrypto not available to compute placeholder CID");
  }
  const cryptoAny = globalThis.crypto;
  const digest3 = await cryptoAny.subtle.digest(
    "SHA-256",
    data
  );
  const b32 = toBase32(new Uint8Array(digest3)).toLowerCase();
  return `baga${b32.slice(4, 59)}`;
}
__name(fakePieceCid, "fakePieceCid");
function toBase32(bytes2) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output2 = "";
  for (let i = 0; i < bytes2.length; i++) {
    const byte = bytes2[i];
    value = value << 8 | byte;
    bits += 8;
    while (bits >= 5) {
      output2 += alphabet.charAt(value >>> bits - 5 & 31);
      bits -= 5;
    }
  }
  if (bits > 0) {
    output2 += alphabet.charAt(value << 5 - bits & 31);
  }
  return output2;
}
__name(toBase32, "toBase32");

// src/index.ts
function json(body, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body, null, 2), { ...init, headers });
}
__name(json, "json");
function unauthorized() {
  return json({ error: "unauthorized" }, { status: 401 });
}
__name(unauthorized, "unauthorized");
function notFound(msg = "not found") {
  return json({ error: msg }, { status: 404 });
}
__name(notFound, "notFound");
async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new Error("invalid JSON");
  }
}
__name(readJson, "readJson");
function requireAdmin(request, env) {
  const want = env.ADMIN_TOKEN;
  if (!want)
    return false;
  const got = request.headers.get("authorization") || "";
  const m = got.match(/Bearer (.+)/i);
  if (!!m && m[1] === want)
    return true;
  const alt = request.headers.get("x-admin-token");
  if (alt && alt === want)
    return true;
  const q = new URL(request.url).searchParams.get("admin");
  if (q && q === want)
    return true;
  return false;
}
__name(requireAdmin, "requireAdmin");
function pdpClient(env) {
  return new PDPClient({
    baseUrl: env.PDP_BASE_URL,
    apiKey: env.SYNAPSE_API_KEY,
    defaultProviderId: env.DEFAULT_PROVIDER_ID,
    privateKeyHex: env.SYNAPSE_PRIVATE_KEY,
    sourceTag: env.SOURCE_TAG
  });
}
__name(pdpClient, "pdpClient");
function dbForOrg(env, org) {
  const key = `DB_${org.replace(/-/g, "_").toUpperCase()}`;
  const db = env[key];
  if (!db)
    throw new Error(`no D1 binding for org ${org} (expected ${key})`);
  return db;
}
__name(dbForOrg, "dbForOrg");
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (request.method === "GET" && (path === "/" || path === "/healthz")) {
        return json({
          name: "OpenScion Filecoin PDP POC",
          version: "0.1.0",
          orgs: ["filecoin-project"],
          pricing: {
            free_tier: "6 months or 1 GB, whichever comes first",
            paid: "$5/GB/month after",
            note: "POC only \u2014 no real billing; contact FilOz to discuss production"
          },
          links: {
            org: "/orgs/filecoin-project"
          }
        });
      }
      const engineHealth = path.match(/^\/orgs\/([^/]+)\/engine\/health$/);
      if (request.method === "GET" && engineHealth) {
        const base2 = env.CONTAINER_URL;
        if (!base2)
          return json({ error: "container not configured" }, { status: 503 });
        const resp = await fetch(`${base2}/healthz`);
        return new Response(await resp.text(), {
          status: resp.status,
          headers: { "content-type": "text/plain" }
        });
      }
      const orgMatch = path.match(/^\/orgs\/([^/]+)$/);
      if (request.method === "GET" && orgMatch) {
        const org = decodeURIComponent(orgMatch[1]);
        return json({
          org,
          databases: [`d1:binding DB_${org.replace(/-/g, "_").toUpperCase()}`],
          apis: {
            providers: `/orgs/${org}/providers`,
            datasets: `/orgs/${org}/datasets`,
            uploads: `/orgs/${org}/uploads`,
            pieces: `/orgs/${org}/pieces/{pieceCid}`
          }
        });
      }
      const provList = path.match(/^\/orgs\/([^/]+)\/providers$/);
      if (request.method === "GET" && provList) {
        const org = decodeURIComponent(provList[1]);
        const db = dbForOrg(env, org);
        const rows = await d1All(
          db,
          "SELECT id, name, endpoint_url, region, status, created_at FROM providers ORDER BY created_at DESC"
        );
        return json({ providers: rows });
      }
      if (request.method === "POST" && provList) {
        const org = decodeURIComponent(provList[1]);
        const db = dbForOrg(env, org);
        if (!requireAdmin(request, env))
          return unauthorized();
        const b = await readJson(request);
        if (!b.id || !b.name) {
          return json({ error: "id and name are required" }, { status: 400 });
        }
        await d1Run(
          db,
          `INSERT OR REPLACE INTO providers (id, name, endpoint_url, region, status, created_at)
           VALUES (?, ?, ?, ?, COALESCE(?, 'active'), ?)`,
          [b.id, b.name, b.endpointUrl ?? null, b.region ?? null, b.status, nowMs()]
        );
        return json({ ok: true, id: b.id });
      }
      const dsList = path.match(/^\/orgs\/([^/]+)\/datasets$/);
      if (request.method === "GET" && dsList) {
        const org = decodeURIComponent(dsList[1]);
        const db = dbForOrg(env, org);
        const rows = await d1All(
          db,
          "SELECT id, name, description, created_at FROM datasets ORDER BY created_at DESC"
        );
        return json({ datasets: rows });
      }
      if (request.method === "POST" && dsList) {
        const org = decodeURIComponent(dsList[1]);
        const db = dbForOrg(env, org);
        if (!requireAdmin(request, env))
          return unauthorized();
        const b = await readJson(request);
        if (!b.name)
          return json({ error: "name is required" }, { status: 400 });
        const id = uuid();
        await d1Run(
          db,
          `INSERT INTO datasets (id, name, description, created_at) VALUES (?, ?, ?, ?)`,
          [id, b.name, b.description ?? null, nowMs()]
        );
        return json({ ok: true, id });
      }
      const uploads = path.match(/^\/orgs\/([^/]+)\/uploads$/);
      if (request.method === "POST" && uploads) {
        const org = decodeURIComponent(uploads[1]);
        const db = dbForOrg(env, org);
        const b = await readJson(request);
        if (!b.datasetId) {
          return json({ error: "datasetId is required" }, { status: 400 });
        }
        let ds = await d1All(
          db,
          "SELECT id FROM datasets WHERE id = ?",
          [b.datasetId]
        );
        if (ds.length === 0 && b.datasetId === "default") {
          await d1Run(
            db,
            `INSERT OR IGNORE INTO datasets (id, name, description, created_at) VALUES (?, ?, ?, ?)`,
            ["default", "default", "auto-created default dataset", nowMs()]
          );
          ds = await d1All(
            db,
            "SELECT id FROM datasets WHERE id = ?",
            [b.datasetId]
          );
        }
        if (ds.length === 0)
          return notFound("unknown dataset");
        const client = pdpClient(env);
        const pieceCid = b.pieceCid ?? (await client.computeCommP({
          bytesBase64: b.bytesBase64,
          contentUrl: b.contentUrl,
          sizeBytes: b.sizeBytes
        })).pieceCid;
        const existing = await d1All(
          db,
          "SELECT piece_cid FROM pieces WHERE piece_cid = ?",
          [pieceCid]
        );
        if (existing.length === 0) {
          await d1Run(
            db,
            `INSERT INTO pieces (piece_cid, dataset_id, size_bytes, provider_id, status, created_at)
             VALUES (?, ?, ?, ?, 'registered', ?)`,
            [
              pieceCid,
              b.datasetId,
              b.sizeBytes ?? null,
              b.providerId ?? env.DEFAULT_PROVIDER_ID ?? null,
              nowMs()
            ]
          );
        }
        const store = await client.storePiece({
          pieceCid,
          providerId: b.providerId,
          bytesBase64: b.bytesBase64
        });
        const uploadId = uuid();
        await d1Run(
          db,
          `INSERT INTO uploads (id, piece_cid, source, state, error, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            uploadId,
            pieceCid,
            b.bytesBase64 ? "inline" : b.contentUrl ? "url" : b.pieceCid ? "reference" : "unspecified",
            store.state,
            store.error ?? null,
            nowMs()
          ]
        );
        await d1Run(
          db,
          `UPDATE pieces SET status = ?, provider_id = COALESCE(?, provider_id) WHERE piece_cid = ?`,
          [store.state, store.providerId ?? null, pieceCid]
        );
        return json({
          ok: true,
          uploadId,
          pieceCid,
          state: store.state,
          note: client ? void 0 : "POC storage initiation (mock mode)"
        });
      }
      const pieceMatch = path.match(/^\/orgs\/([^/]+)\/pieces\/([^/]+)$/);
      if (request.method === "GET" && pieceMatch) {
        const org = decodeURIComponent(pieceMatch[1]);
        const pieceCid = decodeURIComponent(pieceMatch[2]);
        const db = dbForOrg(env, org);
        const rows = await d1All(
          db,
          `SELECT piece_cid, dataset_id, size_bytes, provider_id, status, created_at
           FROM pieces WHERE piece_cid = ?`,
          [pieceCid]
        );
        if (rows.length === 0)
          return notFound("unknown piece");
        return json(rows[0]);
      }
      const pieceBytes = path.match(/^\/orgs\/([^/]+)\/pieces\/([^/]+)\/bytes$/);
      if (request.method === "GET" && pieceBytes) {
        const pieceCid = decodeURIComponent(pieceBytes[2]);
        const client = pdpClient(env);
        try {
          const bytes2 = await client.downloadPiece(pieceCid);
          const buf = new ArrayBuffer(bytes2.byteLength);
          new Uint8Array(buf).set(bytes2);
          return new Response(buf, {
            headers: { "content-type": "application/octet-stream" }
          });
        } catch (e) {
          return json({ error: e.message }, { status: 400 });
        }
      }
      if (request.method === "GET" && path === "/pricing") {
        return json({
          free_tier: "6 months or 1 GB, whichever comes first",
          paid: "$5/GB/month after",
          currency: ["USD", "ETH"],
          disclaimer: "This is a proof-of-concept. No real billing is performed. Contact FilOz to discuss production."
        });
      }
      return json({ error: "route not found" }, { status: 404 });
    } catch (err) {
      return json(
        { error: err.message ?? "internal error" },
        { status: 500 }
      );
    }
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-Hld4GC/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-Hld4GC/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof __Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
__name(__Facade_ScheduledController__, "__Facade_ScheduledController__");
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = (request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    };
    #dispatcher = (type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    };
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
/*! Bundled license information:

@noble/hashes/esm/utils.js:
  (*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) *)

@noble/hashes/esm/utils.js:
  (*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) *)

@noble/curves/esm/abstract/utils.js:
  (*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) *)

@noble/curves/esm/abstract/modular.js:
  (*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) *)

@noble/curves/esm/abstract/curve.js:
  (*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) *)

@noble/curves/esm/abstract/weierstrass.js:
  (*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) *)

@noble/curves/esm/_shortw_utils.js:
  (*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) *)

@noble/curves/esm/secp256k1.js:
  (*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) *)
*/
//# sourceMappingURL=index.js.map
