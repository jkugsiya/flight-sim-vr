import { useEffect } from 'react'
import { BufferGeometry, LineSegments, Material, Mesh, Texture } from 'three'

/**
 * Frees the graphics memory of every geometry, material, and texture found in `value`,
 * looking through meshes, arrays, and plain objects. A material's textures go with it.
 */
export function disposeAll(value: unknown) {
  if (value instanceof BufferGeometry || value instanceof Texture) value.dispose()
  else if (value instanceof Material) {
    for (const property of Object.values(value)) {
      if (property instanceof Texture) property.dispose()
    }
    value.dispose()
  } else if (value instanceof Mesh || value instanceof LineSegments) {
    disposeAll(value.geometry)
    disposeAll(value.material)
  } else if (Array.isArray(value)) for (const item of value) disposeAll(item)
  else if (value && Object.getPrototypeOf(value) === Object.prototype) {
    for (const item of Object.values(value)) disposeAll(item)
  }
}

/** Frees `value` once it is replaced or its component unmounts. */
export function useDisposal(value: unknown) {
  useEffect(() => () => disposeAll(value), [value])
}
