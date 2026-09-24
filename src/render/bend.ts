// Material patching: bends anchor-local unrolled geometry onto the cylinder,
// keeps lighting in each point's local frame, and applies the cylinder
// atmosphere/hologram composite in place of three.js fog.
//
// Geometry convention for bent meshes: positions are (ds, h, dz) relative to
// the mesh's anchor on the base shell. The mesh's matrixWorld is the anchor
// frame from RenderFrame.anchorMatrix(). Instances are placed in the same
// unrolled space (instanceMatrix is applied *before* bending).

import {
  Material,
  MeshDepthMaterial,
  MeshDistanceMaterial,
  RGBADepthPacking,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { atmosphereParsGlsl } from './atmosphereGlsl';
import { U } from './uniforms';

export const bendParsVertex = /* glsl */ `
#ifndef HR_BEND_PARS
#define HR_BEND_PARS
uniform float uR;
uniform float uTime;
varying vec3 vHrWorld;
vec3 hrBend(vec3 p) {
  float th = p.x / uR;
  float r = uR - p.y;
  float sh = sin(0.5 * th);
  return vec3(r * sin(th), p.y + r * 2.0 * sh * sh, p.z);
}
#endif
`;

const projectVertex = /* glsl */ `
vec4 hrLocal = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
  hrLocal = batchingMatrix * hrLocal;
#endif
#ifdef USE_INSTANCING
  hrLocal = instanceMatrix * hrLocal;
#endif
#ifdef HR_BEND
  hrLocal.xyz = hrBend( hrLocal.xyz );
#endif
vec4 mvPosition = modelViewMatrix * hrLocal;
gl_Position = projectionMatrix * mvPosition;
vHrWorld = ( modelMatrix * hrLocal ).xyz;
`;

const worldposVertex = /* glsl */ `
#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
  vec4 worldPosition = vec4( vHrWorld, 1.0 );
#endif
`;

const defaultNormalVertex = /* glsl */ `
vec3 transformedNormal = objectNormal;
#ifdef USE_TANGENT
  vec3 transformedTangent = objectTangent;
#endif
#ifdef USE_BATCHING
  mat3 bm = mat3( batchingMatrix );
  transformedNormal /= vec3( dot( bm[ 0 ], bm[ 0 ] ), dot( bm[ 1 ], bm[ 1 ] ), dot( bm[ 2 ], bm[ 2 ] ) );
  transformedNormal = bm * transformedNormal;
#endif
#ifdef USE_INSTANCING
  mat3 im = mat3( instanceMatrix );
  transformedNormal /= vec3( dot( im[ 0 ], im[ 0 ] ), dot( im[ 1 ], im[ 1 ] ), dot( im[ 2 ], im[ 2 ] ) );
  transformedNormal = im * transformedNormal;
  #ifdef USE_TANGENT
    transformedTangent = im * transformedTangent;
  #endif
#endif
#ifdef HR_BEND
  // Light comes from the axis: shade every point in its own local frame.
  transformedNormal = mat3( viewMatrix ) * transformedNormal;
#else
  transformedNormal = normalMatrix * transformedNormal;
#endif
#ifdef FLIP_SIDED
  transformedNormal = - transformedNormal;
#endif
#ifdef USE_TANGENT
  transformedTangent = ( modelViewMatrix * vec4( transformedTangent, 0.0 ) ).xyz;
#endif
`;

export interface PatchOptions {
  /** Bend geometry onto the cylinder (anchor-local unrolled coordinates). */
  bend?: boolean;
  /** Apply the atmosphere composite at the end of the fragment shader. */
  atmosphere?: boolean;
  /** Extra uniforms merged into the shader. */
  uniforms?: Record<string, { value: unknown }>;
  /** GLSL injected before main() in the vertex shader. */
  vertexPars?: string;
  /** GLSL injected right after #include <begin_vertex> (may modify `transformed`). */
  vertexBegin?: string;
  /** GLSL injected at the end of the vertex shader main(). */
  vertexEnd?: string;
  /** GLSL injected before main() in the fragment shader. */
  fragmentPars?: string;
  /** GLSL injected after #include <color_fragment> (may modify diffuseColor). */
  fragmentColor?: string;
  /** GLSL injected right before the atmosphere composite (may modify gl_FragColor). */
  fragmentEnd?: string;
  /** Keep front-face normals on back faces (grass blades, leaves). */
  noNormalFlip?: boolean;
  /** Unique key for program caching. */
  key: string;
}

function injectVertex(shader: WebGLProgramParametersWithUniforms, o: PatchOptions) {
  let vs = shader.vertexShader;
  vs = vs.replace('#include <common>', `#include <common>\n${bendParsVertex}\n${o.vertexPars ?? ''}`);
  if (o.vertexBegin) vs = vs.replace('#include <begin_vertex>', `#include <begin_vertex>\n${o.vertexBegin}`);
  vs = vs.replace('#include <project_vertex>', projectVertex);
  vs = vs.replace('#include <worldpos_vertex>', worldposVertex);
  vs = vs.replace('#include <defaultnormal_vertex>', defaultNormalVertex);
  if (o.vertexEnd) vs = vs.replace(/}\s*$/, `${o.vertexEnd}\n}`);
  if (o.bend) vs = '#define HR_BEND\n' + vs;
  shader.vertexShader = vs;
}

function injectFragment(shader: WebGLProgramParametersWithUniforms, o: PatchOptions) {
  let fs = shader.fragmentShader;
  const pars = `${o.atmosphere !== false ? atmosphereParsGlsl : ''}\nvarying vec3 vHrWorld;\n${o.fragmentPars ?? ''}`;
  fs = fs.replace('#include <common>', `#include <common>\n${pars}`);
  if (o.fragmentColor) fs = fs.replace('#include <color_fragment>', `#include <color_fragment>\n${o.fragmentColor}`);
  if (o.noNormalFlip) fs = fs.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize( vNormal );');
  const composite =
    (o.fragmentEnd ?? '') +
    (o.atmosphere !== false ? '\ngl_FragColor.rgb = hrComposite( gl_FragColor.rgb, vHrWorld, cameraPosition );\n' : '');
  fs = fs.replace('#include <opaque_fragment>', `#include <opaque_fragment>\n${composite}`);
  shader.fragmentShader = fs;
}

/** Patch a built-in material (Lambert/Standard/Basic/...) for the cylinder world. */
export function patchWorldMaterial<T extends Material>(material: T, o: PatchOptions): T {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U, o.uniforms ?? {});
    injectVertex(shader, o);
    injectFragment(shader, o);
  };
  material.customProgramCacheKey = () => `hr:${o.key}:${o.bend ? 1 : 0}:${o.atmosphere === false ? 0 : 1}`;
  return material;
}

/** Depth material for shadow maps of bent geometry. */
export function makeBentDepthMaterial(key: string, o: Partial<PatchOptions> = {}): MeshDepthMaterial {
  const m = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U, o.uniforms ?? {});
    let vs = shader.vertexShader;
    vs = vs.replace('#include <common>', `#include <common>\n${bendParsVertex}\n${o.vertexPars ?? ''}`);
    if (o.vertexBegin) vs = vs.replace('#include <begin_vertex>', `#include <begin_vertex>\n${o.vertexBegin}`);
    vs = vs.replace('#include <project_vertex>', projectVertex);
    shader.vertexShader = '#define HR_BEND\n' + vs;
    let fs = shader.fragmentShader;
    if (o.fragmentPars) fs = fs.replace('#include <common>', `#include <common>\n${o.fragmentPars}`);
    shader.fragmentShader = fs;
  };
  m.customProgramCacheKey = () => `hrdepth:${key}`;
  return m;
}

export function makeBentDistanceMaterial(key: string): MeshDistanceMaterial {
  const m = new MeshDistanceMaterial();
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U);
    let vs = shader.vertexShader;
    vs = vs.replace('#include <common>', `#include <common>\n${bendParsVertex}`);
    vs = vs.replace('#include <project_vertex>', projectVertex);
    vs = vs.replace('#include <worldpos_vertex>', worldposVertex);
    shader.vertexShader = '#define HR_BEND\n' + vs;
  };
  m.customProgramCacheKey = () => `hrdist:${key}`;
  return m;
}

/** GLSL chunk for custom ShaderMaterials: vertex bend helpers. */
export const customVertexPars = bendParsVertex;
