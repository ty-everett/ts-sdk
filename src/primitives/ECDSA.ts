import BigNumber from './BigNumber.js'
import Signature from './Signature.js'
import Curve from './Curve.js'
import Point from './Point.js'
import DRBG from './DRBG.js'

/**
 * Truncates a BigNumber message to the length of the curve order n, in the context of the Elliptic Curve Digital Signature Algorithm (ECDSA).
 * This method is used as part of ECDSA signing and verification.
 *
 * The method calculates `delta`, which is a difference obtained by subtracting the bit length of the curve order `n` from the byte length of the message in bits.
 * If `delta` is greater than zero, logical shifts msg to the right by `delta`, retaining the sign.
 *
 * Another condition is tested, but only if `truncOnly` is false. This condition compares the value of msg to curve order `n`.
 * If msg is greater or equal to `n`, it is decreased by `n` and returned.
 *
 * @method truncateToN
 * @param msg - The BigNumber message to be truncated.
 * @param truncOnly - An optional boolean parameter that if set to true, the method will only perform truncation of the BigNumber without doing the additional subtraction from the curve order.
 * @returns Returns the truncated BigNumber value, potentially subtracted by the curve order n.
 *
 * @example
 * let msg = new BigNumber('1234567890abcdef', 16);
 * let truncatedMsg = truncateToN(msg);
 */
function truncateToN (
  msg: BigNumber,
  truncOnly?: boolean,
  curve = new Curve()
): BigNumber {
  const delta = msg.byteLength() * 8 - curve.n.bitLength()
  if (delta > 0) {
    msg.iushrn(delta)
  }
  if (truncOnly === null && msg.cmp(curve.n) >= 0) {
    return msg.sub(curve.n)
  } else {
    return msg
  }
}

/**
 * Generates a digital signature for a given message.
 *
 * @function sign
 * @param msg - The BigNumber message for which the signature has to be computed.
 * @param key - Private key in BigNumber.
 * @param forceLowS - Optional boolean flag if True forces "s" to be the lower of two possible values.
 * @param customK - Optional specification for k value, which can be a function or BigNumber.
 * @returns Returns the elliptic curve digital signature of the message.
 *
 * @example
 * const msg = new BigNumber('2664878')
 * const key = new BigNumber('123456')
 * const signature = sign(msg, key)
 */
export const sign = (
  msg: BigNumber,
  key: BigNumber,
  forceLowS: boolean = false,
  customK?: BigNumber | ((iter: number) => BigNumber)
): Signature => {
  const curve = new Curve()
  msg = truncateToN(msg)

  // Zero-extend key to provide enough entropy
  const bytes = curve.n.byteLength()
  const bkey = key.toArray('be', bytes)

  // Zero-extend nonce to have the same byte size as N
  const nonce = msg.toArray('be', bytes)

  // Instantiate Hmac_DRBG
  const drbg = new DRBG(bkey, nonce)

  // Number of bytes to generate
  const ns1 = curve.n.subn(1)

  for (let iter = 0; ; iter++) {
    // Compute the k-value
    let k =
      typeof customK === 'function'
        ? customK(iter)
        : BigNumber.isBN(customK)
          ? customK
          : new BigNumber(drbg.generate(bytes), 16)
    if (k != null) {
      k = truncateToN(k, true)
    } else {
      throw new Error('k is undefined')
    }
    if (k.cmpn(1) <= 0 || k.cmp(ns1) >= 0) {
      if (BigNumber.isBN(customK)) {
        throw new Error(
          'Invalid fixed custom K value (must be more than 1 and less than N-1)'
        )
      } else {
        continue
      }
    }

    const kp = curve.g.mul(k)
    if (kp.isInfinity()) {
      if (BigNumber.isBN(customK)) {
        throw new Error(
          'Invalid fixed custom K value (must not create a point at infinity when multiplied by the generator point)'
        )
      } else {
        continue
      }
    }

    const kpX = kp.getX()
    const r = kpX.umod(curve.n)
    if (r.cmpn(0) === 0) {
      if (BigNumber.isBN(customK)) {
        throw new Error(
          'Invalid fixed custom K value (when multiplied by G, the resulting x coordinate mod N must not be zero)'
        )
      } else {
        continue
      }
    }

    let s = k.invm(curve.n).mul(r.mul(key).iadd(msg))
    s = s.umod(curve.n)
    if (s.cmpn(0) === 0) {
      if (BigNumber.isBN(customK)) {
        throw new Error(
          'Invalid fixed custom K value (when used with the key, it cannot create a zero value for S)'
        )
      } else {
        continue
      }
    }

    // Use complement of `s`, if it is > `n / 2`
    if (forceLowS && s.cmp(curve.n.ushrn(1)) > 0) {
      s = curve.n.sub(s)
    }
    return new Signature(r, s)
  }
}

/**
 * Verifies a digital signature of a given message.
 *
 * Message and key used during the signature generation process, and the previously computed signature
 * are used to validate the authenticity of the digital signature.
 *
 * @function verify
 * @param msg - The BigNumber message for which the signature has to be verified.
 * @param sig - Signature object consisting of parameters 'r' and 's'.
 * @param key - Public key in Point.
 * @returns Returns true if the signature is valid and false otherwise.
 *
 * @example
 * const msg = new BigNumber('2664878', 16)
 * const key = new Point(new BigNumber(10), new BigNumber(20)
 * const signature = sign(msg, new BigNumber('123456'))
 * const isVerified = verify(msg, sig, key)
 */
export const verify = (msg: BigNumber, sig: Signature, key: Point): boolean => {
  // Curve parameters for secp256k1
  const zero = BigInt(0)
  const one = BigInt(1)
  const two = BigInt(2)
  const three = BigInt(3)
  const p = BigInt(
    '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F'
  ) // Field prime
  const n = BigInt(
    '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141'
  ) // Order of the curve
  const G = {
    x: BigInt(
      '0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798'
    ),
    y: BigInt(
      '0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8'
    )
  }

  // Modular arithmetic functions
  const mod = (a: bigint, m: bigint): bigint => ((a % m) + m) % m
  const modInv = (a: bigint, m: bigint): bigint => {
    // Extended Euclidean Algorithm for modular inverse
    let [oldr, r] = [a, m]
    let [olds, s] = [BigInt(1), BigInt(0)]
    while (r !== zero) {
      const q = oldr / r;
      [oldr, r] = [r, oldr - q * r];
      [olds, s] = [s, olds - q * s]
    }
    if (oldr > one) return zero // No inverse
    return mod(olds, m)
  }
  const modMul = (a: bigint, b: bigint, m: bigint): bigint => mod(a * b, m)
  const modSub = (a: bigint, b: bigint, m: bigint): bigint => mod(a - b, m)

  // Define constants
  const four = BigInt(4)
  const eight = BigInt(8)

  // Elliptic curve point operations in Jacobian coordinates
  interface JacobianPoint {
    X: bigint
    Y: bigint
    Z: bigint
  }

  // Point Doubling
  const pointDouble = (P: JacobianPoint): JacobianPoint => {
    const { X: X1, Y: Y1, Z: Z1 } = P

    if (Y1 === zero) {
      return { X: zero, Y: one, Z: zero } // Point at infinity
    }

    const Y1sq = modMul(Y1, Y1, p) // Y1^2
    const S = modMul(four, modMul(X1, Y1sq, p), p) // S = 4 * X1 * Y1^2
    const M = modMul(three, modMul(X1, X1, p), p) // M = 3 * X1^2
    const X3 = modSub(modMul(M, M, p), modMul(two, S, p), p) // X3 = M^2 - 2 * S
    const Y3 = modSub(
      modMul(M, modSub(S, X3, p), p),
      modMul(eight, modMul(Y1sq, Y1sq, p), p),
      p
    ) // Y3 = M * (S - X3) - 8 * Y1^4
    const Z3 = modMul(two, modMul(Y1, Z1, p), p) // Z3 = 2 * Y1 * Z1

    return { X: X3, Y: Y3, Z: Z3 }
  }

  // Point Addition
  const pointAdd = (P: JacobianPoint, Q: JacobianPoint): JacobianPoint => {
    if (P.Z === zero) return Q
    if (Q.Z === zero) return P

    const Z1Z1 = modMul(P.Z, P.Z, p)
    const Z2Z2 = modMul(Q.Z, Q.Z, p)
    const U1 = modMul(P.X, Z2Z2, p)
    const U2 = modMul(Q.X, Z1Z1, p)
    const S1 = modMul(P.Y, modMul(Z2Z2, Q.Z, p), p)
    const S2 = modMul(Q.Y, modMul(Z1Z1, P.Z, p), p)

    const H = modSub(U2, U1, p)
    const r = modSub(S2, S1, p)

    if (H === zero) {
      if (r === zero) {
        // P == Q
        return pointDouble(P)
      } else {
        // Point at infinity
        return { X: zero, Y: one, Z: zero }
      }
    }

    const HH = modMul(H, H, p)
    const HHH = modMul(H, HH, p)
    const V = modMul(U1, HH, p)

    const X3 = modSub(modSub(modMul(r, r, p), HHH, p), modMul(two, V, p), p)
    const Y3 = modSub(modMul(r, modSub(V, X3, p), p), modMul(S1, HHH, p), p)
    const Z3 = modMul(H, modMul(P.Z, Q.Z, p), p)

    return { X: X3, Y: Y3, Z: Z3 }
  }

  // Scalar Multiplication
  const scalarMultiply = (
    k: bigint,
    P: { x: bigint, y: bigint }
  ): JacobianPoint => {
    const N: JacobianPoint = { X: P.x, Y: P.y, Z: one }
    let Q: JacobianPoint = { X: zero, Y: one, Z: zero } // Point at infinity

    const kBin = k.toString(2)
    for (let i = 0; i < kBin.length; i++) {
      Q = pointDouble(Q)
      if (kBin[i] === '1') {
        Q = pointAdd(Q, N)
      }
    }
    return Q
  }

  // Verify Function Using Jacobian Coordinates
  const verifyECDSA = (
    hash: bigint,
    publicKey: { x: bigint, y: bigint },
    signature: { r: bigint, s: bigint }
  ): boolean => {
    const { r, s } = signature
    const z = hash

    // Check r and s are in [1, n - 1]
    if (r <= zero || r >= n || s <= zero || s >= n) {
      return false
    }

    const w = modInv(s, n) // w = s^-1 mod n
    if (w === zero) {
      return false // No inverse exists
    }
    const u1 = modMul(z, w, n)
    const u2 = modMul(r, w, n)

    // Compute point R = u1 * G + u2 * Q
    const RG = scalarMultiply(u1, G)
    const RQ = scalarMultiply(u2, publicKey)
    const R = pointAdd(RG, RQ)

    if (R.Z === zero) {
      // Point at infinity
      return false
    }

    // Compute affine x-coordinate x1 = X / Z^2 mod p
    const ZInv = modInv(R.Z, p)
    if (ZInv === zero) {
      return false // No inverse exists
    }
    const ZInv2 = modMul(ZInv, ZInv, p)
    const x1affine = modMul(R.X, ZInv2, p)

    // Compute v = x1_affine mod n
    const v = mod(x1affine, n)

    // Signature is valid if v == r mod n
    return v === r
  }

  // Convert inputs to BigInt
  const hash = BigInt('0x' + msg.toString(16))
  if ((key.x == null) || (key.y == null)) {
    throw new Error('Invalid public key: missing coordinates.')
  }

  const publicKey = {
    x: BigInt('0x' + key.x.toString(16)),
    y: BigInt('0x' + key.y.toString(16))
  }
  const signature = {
    r: BigInt('0x' + sig.r.toString(16)),
    s: BigInt('0x' + sig.s.toString(16))
  }

  return verifyECDSA(hash, publicKey, signature)
}
