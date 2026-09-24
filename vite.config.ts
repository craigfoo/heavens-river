import { defineConfig, type Plugin } from 'vite';

/**
 * N8AO (ambient occlusion) turns a logarithmic depth value back into a
 * position by way of a standard perspective depth. With our far plane of
 * 4,000 km that loses nearly all precision a few metres from the camera, so
 * the occlusion comes out weak and blotchy. This decodes the view distance
 * directly instead: w = 2^(d log2(far + 1)) - 1, the inverse of three.js's
 * logarithmic depth. Fails the build if N8AO changes and the patch no longer
 * applies.
 */
function n8aoLogDepth(): Plugin {
  const replaceAll = (code: string, re: RegExp, by: string, expect: number, what: string) => {
    let n = 0;
    const out = code.replace(re, () => {
      n++;
      return by;
    });
    if (n !== expect) throw new Error(`n8ao log-depth patch: expected ${expect} × ${what}, found ${n}`);
    return out;
  };
  return {
    name: 'n8ao-log-depth',
    enforce: 'pre',
    transform(code, id) {
      if (!/n8ao[\\/]dist[\\/]N8AO\.js/.test(id)) return null;
      let out = replaceAll(
        code,
        /highp float linearize_depth_log\(highp float d, highp float nearZ,\s*highp float farZ\)\s*\{[\s\S]*?\n\s*\}/g,
        'highp float linearize_depth_log(highp float d, highp float nearZ, highp float farZ) {\n      return exp2(d * log2(farZ + 1.0)) - 1.0;\n    }',
        3,
        'linearize_depth_log',
      );
      out = replaceAll(
        out,
        /vec3 getWorldPosLog\(vec3 posS\)\s*\{[\s\S]*?\n\s*\}/g,
        `vec3 getWorldPosLog(vec3 posS) {
      float w = exp2(posS.z * log2(far + 1.0)) - 1.0;
      vec2 ndc = posS.xy * 2.0 - 1.0;
      mat4 Q = projectionMatrixInv;
      return vec3(Q[0][0] * ndc.x + Q[3][0], Q[1][1] * ndc.y + Q[3][1], -1.0) * w;
    }`,
        4,
        'getWorldPosLog',
      );
      out = replaceAll(
        out,
        /float distWorld = \(farTimesNear\) \/ \(far - offset\.z \* farMinusNear\);/g,
        `#ifdef LOGDEPTH
          float distWorld = -samplePos.z;
          #else
          float distWorld = (farTimesNear) / (far - offset.z * farMinusNear);
          #endif`,
        1,
        'distWorld',
      );
      return { code: out, map: null };
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [n8aoLogDepth()],
  // served unbundled in development so the patch above applies
  optimizeDeps: { exclude: ['n8ao'] },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  server: { host: true },
});
