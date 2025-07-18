import Curve from './Curve.js'

/**
 * Base class for Point (affine coordinates) and JacobianPoint classes,
 * defining their curve and type.
 */
export default abstract class BasePoint {
  curve: Curve
  type: 'affine' | 'jacobian'
  precomputed: {
    doubles?: { step: number, points: any[] }
    naf?: { wnd: number, points: any[] }
    beta?: BasePoint | { x: bigint, y: bigint } | null
  } | null

  constructor (type: 'affine' | 'jacobian') {
    this.curve = new Curve() // Always initialized, so never null
    this.type = type
    this.precomputed = null
  }
}
