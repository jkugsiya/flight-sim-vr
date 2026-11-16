/**
 * Pieces of GLSL that let a custom shader take part in the logarithmic depth buffer, which
 * keeps distant surfaces close to each other, such as a beach and the sea, from flickering.
 * Each does nothing when the renderer runs without one.
 */
export const LOG_DEPTH_VERTEX_PARS = /* glsl */ `
  #include <logdepthbuf_pars_vertex>
`
/** Goes right after the line that sets gl_Position. */
export const LOG_DEPTH_VERTEX = /* glsl */ `
  #ifdef USE_LOGARITHMIC_DEPTH_BUFFER
    vFragDepth = 1.0 + gl_Position.w;
    vIsPerspective = 1.0;
  #endif
`
export const LOG_DEPTH_FRAGMENT_PARS = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
`
/** Goes at the start of main. */
export const LOG_DEPTH_FRAGMENT = /* glsl */ `
  #include <logdepthbuf_fragment>
`

/**
 * Draws a flat overlay, such as a runway or a road, a share of its distance nearer the
 * camera than it is, so it always wins against the ground and the layers beneath it.
 * This replaces polygon offset, which the logarithmic depth buffer ignores. Spread into a
 * material's properties: higher layers take a bigger share.
 */
export function depthBias(share: number) {
  const pull = (1 - share).toFixed(6)
  return {
    onBeforeCompile: (shader: { fragmentShader: string }) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <logdepthbuf_fragment>',
        /* glsl */ `
          #if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
            gl_FragDepth = vIsPerspective == 0.0
              ? gl_FragCoord.z
              : log2( vFragDepth * ${pull} ) * logDepthBufFC * 0.5;
          #endif
        `
      )
    },
    customProgramCacheKey: () => `depth-bias-${pull}`
  }
}
