import { type BufferGeometry, type Material, Matrix4, Mesh, type Object3D } from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

const toParent = new Matrix4()

/**
 * Replaces meshes that never move relative to `parent` with one mesh per material, so the
 * GPU draws each material in one call instead of one per mesh. Call it before the meshes
 * are first drawn. The originals leave the scene and their geometries stay untouched, since
 * other meshes may share them.
 */
export function mergeStill(meshes: Mesh[], parent: Object3D) {
  parent.updateWorldMatrix(true, true)
  const fromWorld = parent.matrixWorld.clone().invert()
  const byMaterial = new Map<Material, Mesh[]>()
  for (const mesh of meshes) {
    // A mirrored mesh would turn inside out once merged, so it stays as it is
    if (toParent.multiplyMatrices(fromWorld, mesh.matrixWorld).determinant() < 0) continue
    const material = mesh.material as Material
    const group = byMaterial.get(material)
    if (group) group.push(mesh)
    else byMaterial.set(material, [mesh])
  }
  for (const [material, group] of byMaterial) {
    if (group.length < 2) continue
    const geometries = group.map(mesh => {
      toParent.multiplyMatrices(fromWorld, mesh.matrixWorld)
      return mesh.geometry.clone().applyMatrix4(toParent)
    })
    const textured = 'map' in material && !!material.map
    // A textured mesh needs texture coordinates on every part
    if (textured && geometries.some(geometry => !geometry.getAttribute('uv'))) continue
    const merged = mergeGeometries(matching(geometries, textured))
    if (!merged) continue
    const mesh = new Mesh(merged, material)
    mesh.castShadow = group.some(each => each.castShadow)
    mesh.receiveShadow = group.some(each => each.receiveShadow)
    for (const each of group) each.removeFromParent()
    parent.add(mesh)
  }
}

/**
 * Gives every geometry the same attributes and indexing, which merging needs: only the
 * attributes they all have, and texture coordinates only when the material has a texture.
 */
function matching(geometries: BufferGeometry[], textured: boolean) {
  const shared = Object.keys(geometries[0].attributes).filter(
    name =>
      (textured || name !== 'uv') &&
      geometries.every(geometry => geometry.getAttribute(name) !== undefined)
  )
  const indexed = geometries.every(geometry => geometry.index !== null)
  return geometries.map(geometry => {
    const each = indexed ? geometry : geometry.toNonIndexed()
    for (const name of Object.keys(each.attributes)) {
      if (!shared.includes(name)) each.deleteAttribute(name)
    }
    each.morphAttributes = {}
    return each
  })
}
