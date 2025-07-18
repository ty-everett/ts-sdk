import BasePoint from './BasePoint.js'
import JPoint from './JacobianPoint.js'
import BigNumber from './BigNumber.js'
import { toArray, toHex } from './utils.js'
import ReductionContext from './ReductionContext.js'
import Curve from './Curve.js'

/**
 * `Point` class is a representation of an elliptic curve point with affine coordinates.
 * It extends the functionality of BasePoint and carries x, y coordinates of point on the curve.
 * It also introduces new methods for handling Point operations in elliptic curve.
 *
 * @class Point
 * @extends {BasePoint}
 *
 * @property x - The x-coordinate of the point.
 * @property y - The y-coordinate of the point.
 * @property inf - Flag to record if the point is at infinity in the Elliptic Curve.
 */
export default class Point extends BasePoint {
  private static readonly red: any = new ReductionContext('k256')
  private static readonly a: BigNumber = new BigNumber(0).toRed(Point.red)
  private static readonly b: BigNumber = new BigNumber(7).toRed(Point.red)
  private static readonly zero: BigNumber = new BigNumber(0).toRed(Point.red)
  x: BigNumber | null
  y: BigNumber | null
  inf: boolean
  xBI: bigint | null
  yBI: bigint | null
  betaBI?: { x: bigint, y: bigint }

  /**
   * Creates a point object from a given Array. These numbers can represent coordinates in hex format, or points
   * in multiple established formats.
   * The function verifies the integrity of the provided data and throws errors if inconsistencies are found.
   *
   * @method fromDER
   * @static
   * @param bytes - The point representation number array.
   * @returns Returns a new point representing the given string.
   * @throws `Error` If the point number[] value has a wrong length.
   * @throws `Error` If the point format is unknown.
   *
   * @example
   * const derPoint = [ 2, 18, 123, 108, 125, 83, 1, 251, 164, 214, 16, 119, 200, 216, 210, 193, 251, 193, 129, 67, 97, 146, 210, 216, 77, 254, 18, 6, 150, 190, 99, 198, 128 ];
   * const point = Point.fromDER(derPoint);
   */
  static fromDER (bytes: number[]): Point {
    const len = 32
    // uncompressed, hybrid-odd, hybrid-even
    if (
      (bytes[0] === 0x04 || bytes[0] === 0x06 || bytes[0] === 0x07) &&
      bytes.length - 1 === 2 * len
    ) {
      if (bytes[0] === 0x06) {
        if (bytes[bytes.length - 1] % 2 !== 0) {
          throw new Error('Point string value is wrong length')
        }
      } else if (bytes[0] === 0x07) {
        if (bytes[bytes.length - 1] % 2 !== 1) {
          throw new Error('Point string value is wrong length')
        }
      }

      const res = new Point(
        bytes.slice(1, 1 + len),
        bytes.slice(1 + len, 1 + 2 * len)
      )

      return res
    } else if (
      (bytes[0] === 0x02 || bytes[0] === 0x03) &&
      bytes.length - 1 === len
    ) {
      return Point.fromX(bytes.slice(1, 1 + len), bytes[0] === 0x03)
    }
    throw new Error('Unknown point format')
  }

  /**
   * Creates a point object from a given string. This string can represent coordinates in hex format, or points
   * in multiple established formats.
   * The function verifies the integrity of the provided data and throws errors if inconsistencies are found.
   *
   * @method fromString
   * @static
   *
   * @param str The point representation string.
   * @returns Returns a new point representing the given string.
   * @throws `Error` If the point string value has a wrong length.
   * @throws `Error` If the point format is unknown.
   *
   * @example
   * const pointStr = 'abcdef';
   * const point = Point.fromString(pointStr);
   */
  static fromString (str: string): Point {
    const bytes = toArray(str, 'hex')
    return Point.fromDER(bytes)
  }

  static redSqrtOptimized (y2: BigNumber): BigNumber {
    const red = Point.red
    const p = red.m // The modulus
    const exponent = p.addn(1).iushrn(2) // (p + 1) / 4
    return y2.redPow(exponent)
  }

  /**
   * Generates a point from an x coordinate and a boolean indicating whether the corresponding
   * y coordinate is odd.
   *
   * @method fromX
   * @static
   * @param x - The x coordinate of the point.
   * @param odd - Boolean indicating whether the corresponding y coordinate is odd or not.
   * @returns Returns the new point.
   * @throws `Error` If the point is invalid.
   *
   * @example
   * const xCoordinate = new BigNumber('10');
   * const point = Point.fromX(xCoordinate, true);
   */
  static fromX (x: BigNumber | number | number[] | string, odd: boolean): Point {
    function mod (a: bigint, n: bigint): bigint {
      return ((a % n) + n) % n
    }
    function modPow (base: bigint, exponent: bigint, modulus: bigint): bigint {
      let result = BigInt(1)
      base = mod(base, modulus)
      while (exponent > BigInt(0)) {
        if ((exponent & BigInt(1)) === BigInt(1)) {
          result = mod(result * base, modulus)
        }
        exponent >>= BigInt(1)
        base = mod(base * base, modulus)
      }
      return result
    }
    function sqrtMod (a: bigint, p: bigint): bigint | null {
      const exponent = (p + BigInt(1)) >> BigInt(2)
      const sqrtCandidate = modPow(a, exponent, p)
      if (mod(sqrtCandidate * sqrtCandidate, p) === mod(a, p)) {
        return sqrtCandidate
      } else {
        return null
      }
    }

    // Curve parameters for secp256k1
    const p = BigInt(
      '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F'
    )
    const b = BigInt(7)

    let xBigInt: bigint
    if (x instanceof BigNumber) {
      xBigInt = BigInt('0x' + x.toString(16))
    } else if (typeof x === 'string') {
      xBigInt = BigInt('0x' + x)
    } else if (Array.isArray(x)) {
      xBigInt = BigInt('0x' + toHex(x).padStart(64, '0'))
    } else if (typeof x === 'number') {
      xBigInt = BigInt(x)
    } else {
      throw new Error('Invalid x-coordinate type')
    }

    xBigInt = mod(xBigInt, p)

    const y2 = mod(modPow(xBigInt, BigInt(3), p) + b, p)

    let y = sqrtMod(y2, p)
    if (y === null) {
      throw new Error('Invalid point')
    }

    const isYOdd = y % BigInt(2) === BigInt(1)
    if ((odd && !isYOdd) || (!odd && isYOdd)) {
      y = p - y
    }

    const xBN = new BigNumber(xBigInt.toString(16), 16)
    const yBN = new BigNumber(y.toString(16), 16)
    return new Point(xBN, yBN)
  }

  /**
   * Generates a point from a serialized JSON object. The function accounts for different options in the JSON object,
   * including precomputed values for optimization of EC operations, and calls another helper function to turn nested
   * JSON points into proper Point objects.
   *
   * @method fromJSON
   * @static
   * @param obj - An object or array that holds the data for the point.
   * @param isRed - A boolean to direct how the Point is constructed from the JSON object.
   * @returns Returns a new point based on the deserialized JSON object.
   *
   * @example
   * const serializedPoint = '{"x":52,"y":15}';
   * const point = Point.fromJSON(serializedPoint, true);
   */
  static fromJSON (obj: string | any[], isRed: boolean): Point {
    if (typeof obj === 'string') {
      obj = JSON.parse(obj)
    }
    const res = new Point(obj[0], obj[1], isRed)
    if (typeof obj[2] !== 'object') {
      return res
    }

    const obj2point = (obj): Point => {
      return new Point(obj[0], obj[1], isRed)
    }

    const pre = obj[2]
    res.precomputed = {
      beta: null,
      doubles:
        typeof pre.doubles === 'object' && pre.doubles !== null
          ? {
              step: pre.doubles.step,
              points: [res].concat(pre.doubles.points.map(obj2point))
            }
          : undefined,
      naf:
        typeof pre.naf === 'object' && pre.naf !== null
          ? {
              wnd: pre.naf.wnd,
              points: [res].concat(pre.naf.points.map(obj2point))
            }
          : undefined
    }
    return res
  }

  /**
   * @constructor
   * @param x - The x-coordinate of the point. May be a number, a BigNumber, a string (which will be interpreted as hex), a number array, or null. If null, an "Infinity" point is constructed.
   * @param y - The y-coordinate of the point, similar to x.
   * @param isRed - A boolean indicating if the point is a member of the field of integers modulo the k256 prime. Default is true.
   *
   * @example
   * new Point('abc123', 'def456');
   * new Point(null, null); // Generates Infinity point.
   */
  constructor (
    x: BigNumber | number | number[] | string | null,
    y: BigNumber | number | number[] | string | null,
    isRed: boolean = true
  ) {
    super('affine')
    this.precomputed = null
    if (x === null && y === null) {
      this.x = null
      this.y = null
      this.inf = true
    } else {
      if (!BigNumber.isBN(x)) {
        x = new BigNumber(x as number, 16)
      }
      this.x = x as BigNumber
      if (!BigNumber.isBN(y)) {
        y = new BigNumber(y as number, 16)
      }
      this.y = y as BigNumber
      // Force redgomery representation when loading from JSON
      if (isRed) {
        this.x.forceRed(this.curve.red)
        this.y.forceRed(this.curve.red)
      }
      if (this.x.red === null) {
        this.x = this.x.toRed(this.curve.red)
      }
      if (this.y.red === null) {
        this.y = this.y.toRed(this.curve.red)
      }
      this.inf = false
    }

    if (typeof BigInt === 'function') {
      this.xBI = this.inf ? null : BigInt('0x' + ((this.x != null) ? this.x.fromRed().toString(16) : '0'))
      this.yBI = this.inf ? null : BigInt('0x' + ((this.y != null) ? this.y.fromRed().toString(16) : '0'))
    } else {
      this.xBI = null
      this.yBI = null
    }
    this.betaBI = undefined
  }

  /**
   * Validates if a point belongs to the curve. Follows the short Weierstrass
   * equation for elliptic curves: y^2 = x^3 + ax + b.
   *
   * @method validate
   * @returns {boolean} true if the point is on the curve, false otherwise.
   *
   * @example
   * const aPoint = new Point(x, y);
   * const isValid = aPoint.validate();
   */
  validate (): boolean {
    return this.curve.validate(this)
  }

  /**
   * Encodes the coordinates of a point into an array or a hexadecimal string.
   * The details of encoding are determined by the optional compact and enc parameters.
   *
   * @method encode
   * @param compact - If true, an additional prefix byte 0x02 or 0x03 based on the 'y' coordinate being even or odd respectively is used. If false, byte 0x04 is used.
   * @param enc - Expects the string 'hex' if hexadecimal string encoding is required instead of an array of numbers.
   * @throws Will throw an error if the specified encoding method is not recognized. Expects 'hex'.
   * @returns If enc is undefined, a byte array representation of the point will be returned. if enc is 'hex', a hexadecimal string representation of the point will be returned.
   *
   * @example
   * const aPoint = new Point(x, y);
   * const encodedPointArray = aPoint.encode();
   * const encodedPointHex = aPoint.encode(true, 'hex');
   */
  encode (compact: boolean = true, enc?: 'hex'): number[] | string {
    const len = this.curve.p.byteLength()
    const x = this.getX().toArray('be', len)
    let res: number[]
    if (compact) {
      res = [this.getY().isEven() ? 0x02 : 0x03].concat(x)
    } else {
      res = [0x04].concat(x, this.getY().toArray('be', len))
    }
    if (enc !== 'hex') {
      return res
    } else {
      return toHex(res)
    }
  }

  /**
   * Converts the point coordinates to a hexadecimal string. A wrapper method
   * for encode. Byte 0x02 or 0x03 is used as prefix based on the 'y' coordinate being even or odd respectively.
   *
   * @method toString
   * @returns {string} A hexadecimal string representation of the point coordinates.
   *
   * @example
   * const aPoint = new Point(x, y);
   * const stringPoint = aPoint.toString();
   */
  toString (): string {
    return this.encode(true, 'hex') as string
  }

  /**
   * Exports the x and y coordinates of the point, and the precomputed doubles and non-adjacent form (NAF) for optimization. The output is an array.
   *
   * @method toJSON
   * @returns An Array where first two elements are the coordinates of the point and optional third element is an object with doubles and NAF points.
   *
   * @example
   * const aPoint = new Point(x, y);
   * const jsonPoint = aPoint.toJSON();
   */
  toJSON (): [
    BigNumber | null,
    BigNumber | null,
    {
      doubles: { step: any, points: any[] } | undefined
      naf: { wnd: any, points: any[] } | undefined
    }?,
  ] {
    if (this.precomputed == null) {
      return [this.x, this.y]
    }

    return [
      this.x,
      this.y,
      typeof this.precomputed === 'object' && this.precomputed !== null
        ? {
            doubles:
            this.precomputed.doubles != null
              ? {
                  step: this.precomputed.doubles.step,
                  points: this.precomputed.doubles.points.slice(1)
                }
              : undefined,
            naf:
            this.precomputed.naf != null
              ? {
                  wnd: this.precomputed.naf.wnd,
                  points: this.precomputed.naf.points.slice(1)
                }
              : undefined
          }
        : undefined
    ]
  }

  /**
   * Provides the point coordinates in a human-readable string format for debugging purposes.
   *
   * @method inspect
   * @returns String of the format '<EC Point x: x-coordinate y: y-coordinate>', or '<EC Point Infinity>' if the point is at infinity.
   *
   * @example
   * const aPoint = new Point(x, y);
   * console.log(aPoint.inspect());
   */
  inspect (): string {
    if (this.isInfinity()) {
      return '<EC Point Infinity>'
    }
    return (
      '<EC Point x: ' +
      (this.x?.fromRed()?.toString(16, 2) ?? 'undefined') +
      ' y: ' +
      (this.y?.fromRed()?.toString(16, 2) ?? 'undefined') +
      '>'
    )
  }

  /**
   * Checks if the point is at infinity.
   * @method isInfinity
   * @returns Returns whether or not the point is at infinity.
   *
   * @example
   * const p = new Point(null, null);
   * console.log(p.isInfinity()); // outputs: true
   */
  isInfinity (): boolean {
    return this.inf
  }

  /**
   * Adds another Point to this Point, returning a new Point.
   *
   * @method add
   * @param p - The Point to add to this one.
   * @returns A new Point that results from the addition.
   *
   * @example
   * const p1 = new Point(1, 2);
   * const p2 = new Point(2, 3);
   * const result = p1.add(p2);
   */
  add (p: Point): Point {
    // O + P = P
    if (this.inf) {
      return p
    }

    // P + O = P
    if (p.inf) {
      return this
    }

    // P + P = 2P
    if (this.eq(p)) {
      return this.dbl()
    }

    // P + (-P) = O
    if (this.neg().eq(p)) {
      return new Point(new BigNumber(0), new BigNumber(0))
    }

    // P + Q = O
    if (this.x?.cmp(p.x ?? new BigNumber(0)) === 0) {
      return new Point(new BigNumber(0), new BigNumber(0))
    }

    let c = this.y?.redSub(p.y ?? new BigNumber(0)) ?? new BigNumber(0)
    if (c.cmpn(0) !== 0) {
      c = c.redMul(this.x?.redSub(p.x ?? new BigNumber(0)).redInvm() ?? new BigNumber(1))
    }

    const nx = c?.redSqr().redISub(this.x ?? new BigNumber(0)).redISub(p.x ?? new BigNumber(0))
    const ny = (c ?? new BigNumber(1))
      .redMul((this.x ?? new BigNumber(0)).redSub(nx ?? new BigNumber(0)))
      .redISub(this.y ?? new BigNumber(0))

    return new Point(nx ?? new BigNumber(0), ny ?? new BigNumber(0))
  }

  /**
   * Doubles the current point.
   *
   * @method dbl
   *
   * @example
   * const P = new Point('123', '456');
   * const result = P.dbl();
   * */
  dbl (): Point {
    if (this.inf) {
      return this
    }

    // 2P = O
    const ys1 = (this.y ?? new BigNumber(0)).redAdd(this.y ?? new BigNumber(0))
    if (ys1.cmpn(0) === 0) {
      return new Point(new BigNumber(0), new BigNumber(0))
    }

    const a = this.curve.a
    const x2 = (this.x ?? new BigNumber(0)).redSqr()
    const dyinv = ys1.redInvm()
    const c = x2.redAdd(x2).redIAdd(x2).redIAdd(a).redMul(dyinv)

    const nx = c.redSqr().redISub((this.x ?? new BigNumber(0)).redAdd(this.x ?? new BigNumber(0)))
    const ny = c.redMul((this.x ?? new BigNumber(0)).redSub(nx)).redISub(this.y ?? new BigNumber(0))

    return new Point(nx, ny)
  }

  /**
   * Returns X coordinate of point
   *
   * @example
   * const P = new Point('123', '456');
   * const x = P.getX();
   */
  getX (): BigNumber {
    return (this.x ?? new BigNumber(0)).fromRed()
  }

  /**
   * Returns X coordinate of point
   *
   * @example
   * const P = new Point('123', '456');
   * const x = P.getX();
   */
  getY (): BigNumber {
    return (this.y ?? new BigNumber(0)).fromRed()
  }

  /**
   * Multiplies this Point by a scalar value, returning a new Point.
   *
   * @method mul
   * @param k - The scalar value to multiply this Point by.
   * @returns  A new Point that results from the multiplication.
   *
   * @example
   * const p = new Point(1, 2);
   * const result = p.mul(2); // this doubles the Point
   */
  mul (k: BigNumber | number | number[] | string): Point {
    if (!BigNumber.isBN(k)) {
      k = new BigNumber(k as number, 16)
    }
    k = k as BigNumber
    if (typeof BigInt === 'function') {
      if (this.inf) {
        return this
      }

      let kBig = BigInt('0x' + k.toString(16))
      const isNeg = kBig < 0n
      if (isNeg) kBig = -kBig
      kBig = biMod(kBig, this.curve.nBI)
      if (kBig === 0n) {
        return new Point(null, null)
      }

      if (this.xBI === null || this.yBI === null) {
        throw new Error('Point coordinates cannot be null')
      }

      if (this.precomputed == null) {
        const power = this.curve._bitLength
        const step = 4
        this.precomputed = {
          doubles: this._getDoubles(step, power)
        }
      }

      let result: Point
      if (this.precomputed != null) {
        // Use fixed comb method
        const combRes = bigIntFixedCombMul(this, kBig)
        const affine = jpToAffine(combRes)
        if (affine === null) {
          result = new Point(null, null)
        } else {
          const xBN = new BigNumber(affine.x.toString(16), 16).toRed(this.curve.red)
          const yBN = new BigNumber(affine.y.toString(16), 16).toRed(this.curve.red)
          result = new Point(xBN, yBN)
        }
      } else {
        // Use endomorphism with wNAF
        const { k1, k2, neg1, neg2 } = endoSplitBI(kBig, this.curve)
        const p1 = { x: this.xBI, y: this.yBI }
        const p2 = this._getBetaBI()
        if (neg1) {
          p1.y = modSubP(0n, p1.y)
        }
        if (neg2) {
          p2.y = modSubP(0n, p2.y)
        }
        const r1 = scalarMultiplyWNAF(k1, p1)
        const r2 = scalarMultiplyWNAF(k2, p2)
        const r = jpAddBI(r1, r2)
        const affine = jpToAffine(r)
        if (affine === null) {
          result = new Point(null, null)
        } else {
          const xBN = new BigNumber(affine.x.toString(16), 16).toRed(this.curve.red)
          const yBN = new BigNumber(affine.y.toString(16), 16).toRed(this.curve.red)
          result = new Point(xBN, yBN)
        }
      }

      if (isNeg) {
        return result.neg()
      }
      return result
    } else {
      if (this.isInfinity()) {
        return this
      } else if (this._hasDoubles(k)) {
        return this._fixedNafMul(k)
      } else {
        return this._endoWnafMulAdd([this], [k]) as Point
      }
    }
  }

  private _getBetaBI (): { x: bigint, y: bigint } {
    if (this.betaBI !== undefined) {
      return this.betaBI
    }
    if (this.curve.endoBI === undefined) {
      throw new Error('Endomorphism not defined')
    }
    const beta = this.curve.endoBI.betaBI
    const x = modMulP(this.xBI!, beta)
    const y = this.yBI!
    this.betaBI = { x, y }
    return { x, y }
  }

  /**
   * Performs a multiplication and addition operation in a single step.
   * Multiplies this Point by k1, adds the resulting Point to the result of p2 multiplied by k2.
   *
   * @method mulAdd
   * @param k1 - The scalar value to multiply this Point by.
   * @param p2 - The other Point to be involved in the operation.
   * @param k2 - The scalar value to multiply the Point p2 by.
   * @returns A Point that results from the combined multiplication and addition operations.
   *
   * @example
   * const p1 = new Point(1, 2);
   * const p2 = new Point(2, 3);
   * const result = p1.mulAdd(2, p2, 3);
   */
  mulAdd (k1: BigNumber, p2: Point, k2: BigNumber): Point {
    const points = [this, p2]
    const coeffs = [k1, k2]
    return this._endoWnafMulAdd(points, coeffs) as Point
  }

  /**
   * Performs the Jacobian multiplication and addition operation in a single
   * step. Instead of returning a regular Point, the result is a JacobianPoint.
   *
   * @method jmulAdd
   * @param k1 - The scalar value to multiply this Point by.
   * @param p2 - The other Point to be involved in the operation
   * @param k2 - The scalar value to multiply the Point p2 by.
   * @returns A JacobianPoint that results from the combined multiplication and addition operation.
   *
   * @example
   * const p1 = new Point(1, 2);
   * const p2 = new Point(2, 3);
   * const result = p1.jmulAdd(2, p2, 3);
   */
  jmulAdd (k1: BigNumber, p2: Point, k2: BigNumber): JPoint {
    const points = [this, p2]
    const coeffs = [k1, k2]
    return this._endoWnafMulAdd(points, coeffs, true) as JPoint
  }

  /**
   * Checks if the Point instance is equal to another given Point.
   *
   * @method eq
   * @param p - The Point to be checked if equal to the current instance.
   *
   * @returns Whether the two Point instances are equal. Both the 'x' and 'y' coordinates have to match, and both points have to either be valid or at infinity for equality. If both conditions are true, it returns true, else it returns false.
   *
   * @example
   * const p1 = new Point(5, 20);
   * const p2 = new Point(5, 20);
   * const areEqual = p1.eq(p2); // returns true
   */
  eq (p: Point): boolean {
    return (
      this === p ||
      (this.inf === p.inf &&
        (this.inf || ((this.x ?? new BigNumber(0)).cmp(p.x ?? new BigNumber(0)) === 0 && (this.y ?? new BigNumber(0)).cmp(p.y ?? new BigNumber(0)) === 0)))
    )
  }

  /**
   * Negate a point. The negation of a point P is the mirror of P about x-axis.
   *
   * @method neg
   *
   * @example
   * const P = new Point('123', '456');
   * const result = P.neg();
   */
  neg (_precompute?: boolean): Point {
    if (this.inf) {
      return this
    }
    const res = new Point(this.x, (this.y ?? new BigNumber(0)).redNeg())
    if (_precompute === true && this.precomputed != null) {
      const pre = this.precomputed
      const negate = (p: Point): Point => p.neg()
      res.precomputed = {
        naf: pre.naf != null
          ? {
              wnd: pre.naf.wnd,
              points: pre.naf.points.map(negate) as BasePoint[]
            }
          : undefined,
        doubles: pre.doubles != null
          ? {
              step: pre.doubles.step,
              points: pre.doubles.points.map((p) => (p as Point).neg())
            }
          : undefined,
        beta: undefined
      }
    }

    return res
  }

  /**
   * Performs the "doubling" operation on the Point a given number of times.
   * This is used in elliptic curve operations to perform multiplication by 2, multiple times.
   * If the point is at infinity, it simply returns the point because doubling
   * a point at infinity is still infinity.
   *
   * @method dblp
   * @param k - The number of times the "doubling" operation is to be performed on the Point.
   * @returns The Point after 'k' "doubling" operations have been performed.
   *
   * @example
   * const p = new Point(5, 20);
   * const doubledPoint = p.dblp(10); // returns the point after "doubled" 10 times
   */
  dblp (k: number): Point {
    /* eslint-disable @typescript-eslint/no-this-alias */
    let r: Point = this
    for (let i = 0; i < k; i++) {
      r = r.dbl()
    }
    return r
  }

  /**
   * Converts the point to a Jacobian point. If the point is at infinity, the corresponding Jacobian point
   * will also be at infinity.
   *
   * @method toJ
   * @returns Returns a new Jacobian point based on the current point.
   *
   * @example
   * const point = new Point(xCoordinate, yCoordinate);
   * const jacobianPoint = point.toJ();
   */
  toJ (): JPoint {
    if (this.inf) {
      return new JPoint(null, null, null)
    }
    const res = new JPoint(this.x, this.y, this.curve.one)
    return res
  }

  private _getBeta (): undefined | Point {
    if (typeof this.curve.endo !== 'object') {
      return
    }

    const pre = this.precomputed
    if (
      typeof pre === 'object' &&
      pre !== null &&
      typeof pre.beta === 'object' &&
      pre.beta !== null
    ) {
      return pre.beta as Point
    }

    const beta = new Point((this.x ?? new BigNumber(0)).redMul(this.curve.endo.beta), this.y)
    if (pre != null) {
      const curve = this.curve
      const endoMul = (p: Point): Point => {
        if (p.x === null) {
          throw new Error('p.x is null')
        }
        if (curve.endo === undefined || curve.endo === null) {
          throw new Error('curve.endo is undefined')
        }
        return new Point(p.x.redMul(curve.endo.beta), p.y)
      }
      pre.beta = beta
      beta.precomputed = {
        beta: null,
        naf:
          pre.naf != null
            ? {
                wnd: pre.naf.wnd,
                points: pre.naf.points.map(endoMul)
              }
            : undefined,
        doubles:
          pre.doubles != null
            ? {
                step: pre.doubles.step,
                points: pre.doubles.points.map(endoMul)
              }
            : undefined
      }
    }
    return beta
  }

  private _fixedNafMul (k: BigNumber): Point {
    if (typeof this.precomputed !== 'object' || this.precomputed === null) {
      throw new Error('_fixedNafMul requires precomputed values for the point')
    }
    const doubles = this._getDoubles()

    const naf = this.curve.getNAF(k, 1, this.curve._bitLength)
    let I = (1 << (doubles.step + 1)) - (doubles.step % 2 === 0 ? 2 : 1)
    I /= 3

    // Translate into more windowed form
    const repr: number[] = []
    for (let j = 0; j < naf.length; j += doubles.step) {
      let nafW = 0
      for (let k = j + doubles.step - 1; k >= j; k--) {
        nafW = (nafW << 1) + naf[k]
      }
      repr.push(nafW)
    }

    let a = new JPoint(null, null, null)
    let b = new JPoint(null, null, null)
    for (let i = I; i > 0; i--) {
      for (let j = 0; j < repr.length; j++) {
        const nafW = repr[j]
        if (nafW === i) {
          b = b.mixedAdd(doubles.points[j])
        } else if (nafW === -i) {
          b = b.mixedAdd(doubles.points[j].neg())
        }
      }
      a = a.add(b)
    }
    return a.toP()
  }

  private _wnafMulAdd (
    defW: number,
    points: Point[],
    coeffs: BigNumber[],
    len: number,
    jacobianResult?: boolean
  ): BasePoint {
    const wndWidth: number[] = this.curve._wnafT1.map(num => num.toNumber()) // Convert BigNumber to number
    const wnd: Point[][] = this.curve._wnafT2.map(() => []) // Initialize as empty Point[][] array
    const naf: number[][] = this.curve._wnafT3.map(() => []) // Initialize as empty number[][] array

    // Fill all arrays
    let max = 0
    for (let i = 0; i < len; i++) {
      const p = points[i]
      const nafPoints = p._getNAFPoints(defW)
      wndWidth[i] = nafPoints.wnd // Ensure correct type
      wnd[i] = nafPoints.points // Ensure correct type
    }

    // Comb small window NAFs
    for (let i = len - 1; i >= 1; i -= 2) {
      const a = i - 1
      const b = i
      if (wndWidth[a] !== 1 || wndWidth[b] !== 1) {
        naf[a] = this.curve.getNAF(
          coeffs[a],
          wndWidth[a],
          this.curve._bitLength
        )
        naf[b] = this.curve.getNAF(
          coeffs[b],
          wndWidth[b],
          this.curve._bitLength
        )
        max = Math.max(naf[a].length, max)
        max = Math.max(naf[b].length, max)
        continue
      }

      const comb: any[] = [
        points[a] /* 1 */,
        null /* 3 */,
        null /* 5 */,
        points[b] /* 7 */
      ]

      // Try to avoid Projective points, if possible
      if ((points[a].y ?? new BigNumber(0)).cmp(points[b].y ?? new BigNumber(0)) === 0) {
        comb[1] = points[a].add(points[b])
        comb[2] = points[a].toJ().mixedAdd(points[b].neg())
      } else if ((points[a].y ?? new BigNumber(0)).cmp((points[b].y ?? new BigNumber(0)).redNeg()) === 0) {
        comb[1] = points[a].toJ().mixedAdd(points[b])
        comb[2] = points[a].add(points[b].neg())
      } else {
        comb[1] = points[a].toJ().mixedAdd(points[b])
        comb[2] = points[a].toJ().mixedAdd(points[b].neg())
      }

      const index = [
        -3 /* -1 -1 */, -1 /* -1 0 */, -5 /* -1 1 */, -7 /* 0 -1 */,
        0 /* 0 0 */, 7 /* 0 1 */, 5 /* 1 -1 */, 1 /* 1 0 */, 3 /* 1 1 */
      ]

      const jsf = this.curve.getJSF(coeffs[a], coeffs[b])
      max = Math.max(jsf[0].length, max)
      naf[a] = new Array(max)
      naf[b] = new Array(max)
      for (let j = 0; j < max; j++) {
        const ja = jsf[0][j] | 0
        const jb = jsf[1][j] | 0

        naf[a][j] = index[(ja + 1) * 3 + (jb + 1)]
        naf[b][j] = 0
        wnd[a] = comb
      }
    }

    let acc = new JPoint(null, null, null)
    const tmp = this.curve._wnafT4
    for (let i = max; i >= 0; i--) {
      let k = 0

      while (i >= 0) {
        let zero = true
        for (let j = 0; j < len; j++) {
          tmp[j] = new BigNumber(typeof naf[j][i] === 'number' ? naf[j][i] : 0) // Ensure type consistency
          if (!tmp[j].isZero()) { // Use BigNumber's built-in comparison
            zero = false
          }
        }
        if (!zero) {
          break
        }
        k++
        i--
      }
      if (i >= 0) {
        k++
      }
      acc = acc.dblp(k)
      if (i < 0) {
        break
      }

      const one = new BigNumber(1)
      const two = new BigNumber(2)

      for (let j = 0; j < len; j++) {
        const z = tmp[j]
        let p

        if (z.cmpn(0) === 0) { // Check if z is 0
          continue
        } else if (!z.isNeg()) { // If z is positive
          p = wnd[j][z.sub(one).div(two).toNumber()]
        } else { // If z is negative
          p = wnd[j][z.neg().sub(one).div(two).toNumber()].neg()
        }

        if (p.type === 'affine') {
          acc = acc.mixedAdd(p)
        } else {
          acc = acc.add(p)
        }
      }
    }
    // Zeroify references
    for (let i = 0; i < len; i++) {
      wnd[i] = []
    }

    if (jacobianResult === true) {
      return acc
    } else {
      return acc.toP()
    }
  }

  private _endoWnafMulAdd (
    points: Point[],
    coeffs: BigNumber[], // Explicitly type coeffs
    jacobianResult?: boolean
  ): BasePoint {
    const npoints: Point[] = new Array(points.length * 2)
    const ncoeffs: BigNumber[] = new Array(points.length * 2)
    let i: number
    for (i = 0; i < points.length; i++) {
      const split = this.curve._endoSplit(coeffs[i])
      let p = points[i]
      let beta: Point = p._getBeta() ?? new Point(new BigNumber(0), new BigNumber(0))

      if (split.k1.negative !== 0) {
        split.k1.ineg()
        p = p.neg(true)
      }
      if (split.k2.negative !== 0) {
        split.k2.ineg()
        beta = beta.neg(true)
      }

      npoints[i * 2] = p
      npoints[i * 2 + 1] = beta
      ncoeffs[i * 2] = split.k1
      ncoeffs[i * 2 + 1] = split.k2
    }

    const res = this._wnafMulAdd(1, npoints, ncoeffs, i * 2, jacobianResult)

    // Clean-up references to points and coefficients
    for (let j = 0; j < i * 2; j++) {
      npoints[j] = null as unknown as Point
      ncoeffs[j] = null as unknown as BigNumber
    }
    return res
  }

  private _hasDoubles (k: BigNumber): boolean {
    if (this.precomputed == null) {
      return false
    }

    const doubles = this.precomputed.doubles
    if (typeof doubles !== 'object') {
      return false
    }

    return (
      doubles.points.length >= Math.ceil((k.bitLength() + 1) / doubles.step)
    )
  }

  private _getDoubles (
    step?: number,
    power?: number
  ): { step: number, points: any[] } {
    if (
      typeof this.precomputed === 'object' &&
      this.precomputed !== null &&
      typeof this.precomputed.doubles === 'object' &&
      this.precomputed.doubles !== null
    ) {
      return this.precomputed.doubles
    }

    const doubles = [this]
    /* eslint-disable @typescript-eslint/no-this-alias */
    let acc: Point = this
    for (let i = 0; i < (power ?? 0); i += (step ?? 1)) {
      for (let j = 0; j < (step ?? 1); j++) {
        acc = acc.dbl()
      }
      doubles.push(acc as this)
    }

    if (typeof BigInt === 'function') {
      const converted = doubles.map((p: Point) => ({
        X: BigInt('0x' + (p.x as BigNumber).fromRed().toString(16)),
        Y: BigInt('0x' + (p.y as BigNumber).fromRed().toString(16)),
        Z: 1n
      }))
      return { step: step ?? 1, points: converted }
    }

    return {
      step: step ?? 1,
      points: doubles
    }
  }

  private _getNAFPoints (wnd: number): { wnd: number, points: any[] } {
    if (
      typeof this.precomputed === 'object' &&
      this.precomputed !== null &&
      typeof this.precomputed.naf === 'object' &&
      this.precomputed.naf !== null
    ) {
      return this.precomputed.naf
    }

    const res = [this]
    const max = (1 << wnd) - 1
    const dbl = max === 1 ? null : this.dbl()
    for (let i = 1; i < max; i++) {
      if (dbl !== null) {
        res[i] = res[i - 1].add(dbl) as this
      }
    }
    return {
      wnd,
      points: res
    }
  }
}

// -----------------------------------------------------------------------------
// BigInt helpers & constants (secp256k1) – hoisted so we don't recreate them on
// every Point.mul() call.  These are ONLY used when the runtime supports
// native BigInt and therefore only affect the fast-path we add below.
// -----------------------------------------------------------------------------
const BI_ZERO = 0n
const BI_ONE = 1n
const BI_TWO = 2n
const BI_THREE = 3n
const BI_FOUR = 4n
const BI_EIGHT = 8n

// Field prime (p) and group order (n) for secp256k1
const P_BIGINT = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn
const MU_P = 0x100000000000000000000000000000000000000000000000000000001000003d1n

function modP (x: bigint): bigint {
  const q = (x * MU_P) >> 512n
  let r = x - q * P_BIGINT
  if (r >= P_BIGINT) r -= P_BIGINT
  return r
}

function modMulP (a: bigint, b: bigint): bigint {
  return modP(a * b)
}

function modSubP (a: bigint, b: bigint): bigint {
  let r = a - b
  if (r < 0n) r += P_BIGINT
  return r
}

function modInv (a: bigint, m: bigint): bigint {
  let lm = BI_ONE
  let hm = BI_ZERO
  let low = biMod(a, m)
  let high = m
  while (low > BI_ONE) {
    const r = high / low
    const nm = hm - lm * r
    const neww = high - low * r
    hm = lm
    lm = nm
    high = low
    low = neww
  }
  return biMod(lm, m)
}

interface JacobianPointBI { X: bigint, Y: bigint, Z: bigint }

const jpDoubleBI = (P: JacobianPointBI): JacobianPointBI => {
  const { X: X1, Y: Y1, Z: Z1 } = P
  if (Y1 === BI_ZERO) return { X: BI_ZERO, Y: BI_ONE, Z: BI_ZERO }

  const Y1sq = modMulP(Y1, Y1)
  const S = modMulP(BI_FOUR, modMulP(X1, Y1sq))
  const M = modMulP(BI_THREE, modMulP(X1, X1))
  const X3 = modSubP(modMulP(M, M), modMulP(BI_TWO, S))
  const Y3 = modSubP(
    modMulP(M, modSubP(S, X3)),
    modMulP(BI_EIGHT, modMulP(Y1sq, Y1sq))
  )
  const Z3 = modMulP(BI_TWO, modMulP(Y1, Z1))
  return { X: X3, Y: Y3, Z: Z3 }
}

const jpAddBI = (P: JacobianPointBI, Q: JacobianPointBI): JacobianPointBI => {
  if (P.Z === BI_ZERO) return Q
  if (Q.Z === BI_ZERO) return P

  const Z1Z1 = modMulP(P.Z, P.Z)
  const Z2Z2 = modMulP(Q.Z, Q.Z)
  const U1 = modMulP(P.X, Z2Z2)
  const U2 = modMulP(Q.X, Z1Z1)
  const S1 = modMulP(P.Y, modMulP(Z2Z2, Q.Z))
  const S2 = modMulP(Q.Y, modMulP(Z1Z1, P.Z))

  const H = modSubP(U2, U1)
  const r = modSubP(S2, S1)
  if (H === BI_ZERO) {
    if (r === BI_ZERO) return jpDoubleBI(P)
    return { X: BI_ZERO, Y: BI_ONE, Z: BI_ZERO } // Infinity
  }

  const HH = modMulP(H, H)
  const HHH = modMulP(H, HH)
  const V = modMulP(U1, HH)

  const X3 = modSubP(modSubP(modMulP(r, r), HHH), modMulP(BI_TWO, V))
  const Y3 = modSubP(modMulP(r, modSubP(V, X3)), modMulP(S1, HHH))
  const Z3 = modMulP(H, modMulP(P.Z, Q.Z))
  return { X: X3, Y: Y3, Z: Z3 }
}

const jpNegBI = (P: JacobianPointBI): JacobianPointBI => {
  if (P.Z === BI_ZERO) return P
  return { X: P.X, Y: modSubP(0n, P.Y), Z: P.Z }
}

// Fast windowed-NAF scalar multiplication (default window = 5) in Jacobian
// coordinates.  Returns Q = k * P0 as a JacobianPoint.
const scalarMultiplyWNAF = (
  k: bigint,
  P0: { x: bigint, y: bigint },
  window: number = 5
): JacobianPointBI => {
  if (k <= 16n) {
    let res = { X: BI_ZERO, Y: BI_ONE, Z: BI_ZERO }
    const Pjp = { X: P0.x, Y: P0.y, Z: BI_ONE }
    for (let i = 0n; i < k; i++) {
      res = jpAddBI(res, Pjp)
    }
    return res
  }

  // Convert affine to Jacobian
  const P: JacobianPointBI = { X: P0.x, Y: P0.y, Z: BI_ONE }

  // Pre-compute odd multiples: P, 3P, 5P, … up to 2^{w-1}-1
  const tblSize = 1 << (window - 1) // e.g. w=5 → 16 entries
  const tbl: JacobianPointBI[] = new Array(tblSize)
  tbl[0] = P
  const twoP = jpDoubleBI(P)
  for (let i = 1; i < tblSize; i++) {
    tbl[i] = jpAddBI(tbl[i - 1], twoP)
  }

  // Build wNAF representation of k
  const wnaf: number[] = []
  const wBig = 1n << BigInt(window)
  const wHalf = wBig >> 1n
  let kTmp = k
  while (kTmp > 0n) {
    if ((kTmp & BI_ONE) === BI_ZERO) {
      wnaf.push(0)
      kTmp >>= BI_ONE
    } else {
      let z = kTmp & (wBig - 1n) // kTmp mod 2^w
      if (z > wHalf) z -= wBig // make it odd & within (-2^{w-1}, 2^{w-1})
      wnaf.push(Number(z))
      kTmp -= z
      kTmp >>= BI_ONE
    }
  }

  // Accumulate from MSB to LSB
  let Q: JacobianPointBI = { X: BI_ZERO, Y: BI_ONE, Z: BI_ZERO } // infinity
  for (let i = wnaf.length - 1; i >= 0; i--) {
    Q = jpDoubleBI(Q)
    const di = wnaf[i]
    if (di !== 0) {
      const idx = Math.abs(di) >> 1 // (|di|-1)/2  because di is odd
      const addend = di > 0 ? tbl[idx] : jpNegBI(tbl[idx])
      Q = jpAddBI(Q, addend)
    }
  }
  return Q
}

function roundDivBI (num: bigint, den: bigint): bigint {
  let quot = num / den
  let mod = num % den
  if (mod < 0n) {
    mod += den
    quot -= 1n
  }
  const half = den >> 1n
  let cmp: number
  if (mod > half) {
    cmp = 1
  } else if (mod < half) {
    cmp = -1
  } else {
    cmp = 0
  }
  const r2 = den & 1n
  if (cmp < 0 || (r2 === 1n && cmp === 0)) {
    return quot
  } else {
    return quot + 1n
  }
}

function endoSplitBI (k: bigint, curve: Curve): { k1: bigint, k2: bigint, neg1: boolean, neg2: boolean } {
  if (curve.endoBI === undefined) {
    throw new Error('Endomorphism not defined')
  }
  const v1 = curve.endoBI.basisBI[0]
  const v2 = curve.endoBI.basisBI[1]
  const c1 = roundDivBI(v2.bBI * k, curve.nBI)
  const c2 = roundDivBI((-v1.bBI) * k, curve.nBI)
  let k1 = k - c1 * v1.aBI - c2 * v2.aBI
  let k2 = -(c1 * v1.bBI + c2 * v2.bBI)
  const neg1 = k1 < 0n
  if (neg1) k1 = -k1
  const neg2 = k2 < 0n
  if (neg2) k2 = -k2
  return { k1, k2, neg1, neg2 }
}

function bigIntFixedCombMul (point: Point, k: bigint): JacobianPointBI {
  if (point.precomputed == null || point.precomputed.doubles == null) {
    throw new Error('Precomputed doubles required for fixed comb multiplication')
  }
  const doubles = point.precomputed.doubles
  const step: number = doubles.step
  const bits = point.curve._bitLength
  const naf = Curve.getNAFBI(k, 1, bits)
  let I = (1 << (step + 1)) - (step % 2 === 0 ? 2 : 1)
  I = Math.floor(I / 3)
  const repr: number[] = []
  for (let j = 0; j < naf.length; j += step) {
    let nafW = 0
    for (let l = j + step - 1; l >= j; l--) {
      nafW = (nafW << 1) + naf[l]
    }
    repr.push(nafW)
  }
  let a: JacobianPointBI = { X: BI_ZERO, Y: BI_ONE, Z: BI_ZERO }
  let b: JacobianPointBI = { X: BI_ZERO, Y: BI_ONE, Z: BI_ZERO }
  for (let i = I; i > 0; i--) {
    for (let j = 0; j < repr.length; j++) {
      const nafW = repr[j]
      if (nafW === i) {
        b = jpAddBI(b, doubles.points[j])
      } else if (nafW === -i) {
        b = jpAddBI(b, jpNegBI(doubles.points[j]))
      }
    }
    a = jpAddBI(a, b)
  }
  return a
}

function jpToAffine (jp: JacobianPointBI): { x: bigint, y: bigint } | null {
  if (jp.Z === 0n) return null
  const zinv = modInv(jp.Z, P_BIGINT)
  const zinv2 = modMulP(zinv, zinv)
  const x = modMulP(jp.X, zinv2)
  const zinv3 = modMulP(zinv2, zinv)
  const y = modMulP(jp.Y, zinv3)
  return { x, y }
}

function biMod (a: bigint, m: bigint): bigint {
  const r = a % m
  return r >= 0n ? r : r + m
}
