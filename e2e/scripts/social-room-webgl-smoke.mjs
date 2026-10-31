#!/usr/bin/env node
/**
 * Genuine Chromium rendering smoke for both 3D Social Space shader profiles.
 *
 * Not a substitute for physical Android/iOS fps and power tests. Browser uses
 * a software GPU to ensure the actual GLSL compiles, links, draws and returns
 * pixels. No screenshots, network calls, retries, mocking or skipped profiles.
 */
import { chromium } from '@playwright/test';
import { socialRoomShaderSources } from '../../client/js/core/activities/social-room-render-policy.ts';

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  const result = await page.evaluate(({ modern, legacy }) => {
    function testProfile(contextType, sources) {
      const canvas = document.createElement('canvas');
      canvas.width = 48;
      canvas.height = 48;
      const gl = canvas.getContext(contextType, { alpha: false, preserveDrawingBuffer: true });
      if (!gl) throw new Error(contextType + ' context unavailable in Chromium');
      const compile = (kind, src) => {
        const shader = gl.createShader(kind);
        if (!shader) throw new Error(contextType + ' shader allocation failed');
        gl.shaderSource(shader, src);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          throw new Error(contextType + ' shader compile: ' + gl.getShaderInfoLog(shader));
        }
        return shader;
      };
      const vertex = compile(gl.VERTEX_SHADER, sources.vertex);
      const fragment = compile(gl.FRAGMENT_SHADER, sources.fragment);
      const program = gl.createProgram();
      if (!program) throw new Error(contextType + ' program allocation failed');
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(contextType + ' program link: ' + gl.getProgramInfoLog(program));
      }
      gl.useProgram(program);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      const data = new Float32Array([
        -0.9, -0.9, 0, 1, 0.05, 0.05,
         0.9, -0.9, 0, 1, 0.05, 0.05,
         0.0,  0.9, 0, 1, 0.05, 0.05,
      ]);
      const buffer = gl.createBuffer();
      if (!buffer) throw new Error(contextType + ' vertex buffer unavailable');
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, 'aPosition');
      const color = gl.getAttribLocation(program, 'aColor');
      if (position < 0 || color < 0) throw new Error(contextType + ' missing input attributes');
      gl.enableVertexAttribArray(position);
      gl.enableVertexAttribArray(color);
      gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 24, 0);
      gl.vertexAttribPointer(color, 3, gl.FLOAT, false, 24, 12);
      const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const projection = gl.getUniformLocation(program, 'uProjection');
      const view = gl.getUniformLocation(program, 'uView');
      if (!projection || !view) throw new Error(contextType + ' missing transforms');
      gl.uniformMatrix4fv(projection, false, identity);
      gl.uniformMatrix4fv(view, false, identity);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const pixels = new Uint8Array(4);
      gl.readPixels(24, 24, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const error = gl.getError();
      if (error !== gl.NO_ERROR) throw new Error(contextType + ' GL error ' + error);
      if (pixels[0] < 100) throw new Error(contextType + ' triangle pixel not rendered');
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      return { contextType, pixelRed: pixels[0], pixelAlpha: pixels[3] };
    }
    return [testProfile('webgl2', modern), testProfile('webgl', legacy)];
  }, { modern: socialRoomShaderSources('webgl2'), legacy: socialRoomShaderSources('webgl1') });

  if (result.length !== 2 || result.some(entry => entry.pixelAlpha !== 255)) {
    throw new Error('Both graphics profiles must have fully opaque rendered pixels');
  }
  console.log('SOCIAL_3D_REAL_CHROMIUM_WEBGL:2/2:0_skipped');
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
