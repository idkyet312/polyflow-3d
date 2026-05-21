import { defineConfig } from 'vite';

export default defineConfig({
  base: '/polyflow-3d/',
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          minSize: 20000,
          groups: [
            { name: 'vendor-three', test: /node_modules[\\/]three[\\/]/, priority: 40 },
            { name: 'vendor-physics', test: /node_modules[\\/]jolt-physics[\\/]/, priority: 30 },
            { name: 'vendor-realtime', test: /node_modules[\\/]socket\.io/, priority: 20 },
            { name: 'vendor-ui', test: /node_modules[\\/](gsap|meshoptimizer|three-mesh-bvh|xatlas-web)[\\/]/, priority: 10 }
          ]
        }
      }
    }
  }
});
