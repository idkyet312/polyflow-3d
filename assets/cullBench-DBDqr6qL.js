import{Bt as e,Dt as t,Pn as n,_n as r,gt as i,mn as a,pn as o,tn as s,vt as c,xn as l,yn as u}from"./vendor-three-5ejyBGux.js";var d=[1e3,1e4,5e4,1e5],f=60,p=300,m=600,h=220;function g(){return new t(4,4,4)}function _(e,t){let n=t=>{let n=Math.sin((e+1)*12.9898+t*78.233)*43758.5453;return n-Math.floor(n)};return[(n(1)*2-1)*m,(n(2)*2-1)*m,(n(3)*2-1)*m]}function v(e,t,n,r){let i=[];for(let o=0;o<r;o++){let s=new a(t,n),[c,l,u]=_(o,r);s.position.set(c,l,u),s.updateMatrix(),s.matrixAutoUpdate=!1,e.add(s),i.push(s)}return{dispose:()=>i.forEach(t=>e.remove(t))}}function y(e,t,n,r){let i=new s(t,n,r);i.frustumCulled=!1;let a=new u;for(let e=0;e<r;e++){let[t,n,o]=_(e,r);a.position.set(t,n,o),a.updateMatrix(),i.setMatrixAt(e,a.matrix)}return i.instanceMatrix.needsUpdate=!0,e.add(i),{dispose:()=>e.remove(i)}}var b=`
struct Cam { viewProj: mat4x4<f32>, };
struct DrawArgs {
  indexCount: u32, instanceCount: atomic<u32>,
  firstIndex: u32, baseVertex: u32, firstInstance: u32,
};
@group(0) @binding(0) var<uniform> cam: Cam;
@group(0) @binding(1) var<storage, read> srcPos: array<vec4<f32>>; // xyz = world pos
@group(0) @binding(2) var<storage, read_write> dstPos: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> args: DrawArgs;
@group(0) @binding(4) var<uniform> params: vec4<u32>; // x = count

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.x) { return; }
  let p = srcPos[i].xyz;
  // clip-space frustum test of the instance center (+ generous radius).
  let clip = cam.viewProj * vec4<f32>(p, 1.0);
  let w = clip.w;
  let r = 6.0; // box half-diagonal-ish guard so edge instances aren't popped
  let inside =
      clip.z >= -w - r && clip.z <= w + r &&
      clip.x >= -w - r && clip.x <= w + r &&
      clip.y >= -w - r && clip.y <= w + r &&
      w > 0.0;
  if (inside) {
    let slot = atomicAdd(&args.instanceCount, 1u);
    dstPos[slot] = vec4<f32>(p, 1.0);
  }
}
`,x=`
struct Cam { viewProj: mat4x4<f32>, };
@group(0) @binding(0) var<uniform> cam: Cam;
@group(0) @binding(1) var<storage, read> inst: array<vec4<f32>>;

struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) n: vec3<f32>, };

@vertex
fn vs(@location(0) p: vec3<f32>, @location(1) nrm: vec3<f32>,
      @builtin(instance_index) ii: u32) -> VSOut {
  var o: VSOut;
  let wp = p + inst[ii].xyz;
  o.pos = cam.viewProj * vec4<f32>(wp, 1.0);
  o.n = nrm;
  return o;
}
@fragment
fn fs(i: VSOut) -> @location(0) vec4<f32> {
  let l = max(dot(normalize(i.n), normalize(vec3<f32>(0.4, 0.8, 0.3))), 0.15);
  return vec4<f32>(vec3<f32>(0.8, 0.5, 0.35) * l, 1.0);
}
`;async function S(e,t,n,r){let i=e.backend?.device;if(!i)throw Error(`no WebGPU device on renderer.backend`);let a=new Float32Array(n*4);for(let e=0;e<n;e++){let[t,r,i]=_(e,n);a[e*4]=t,a[e*4+1]=r,a[e*4+2]=i,a[e*4+3]=1}let o=i.createBuffer({size:a.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});i.queue.writeBuffer(o,0,a);let s=i.createBuffer({size:a.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),c=t.attributes.position.array,l=t.attributes.normal.array,u=t.index.array,d=i.createBuffer({size:c.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST}),f=i.createBuffer({size:l.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST}),p=new Uint32Array(u),m=i.createBuffer({size:p.byteLength,usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST});i.queue.writeBuffer(d,0,c),i.queue.writeBuffer(f,0,l),i.queue.writeBuffer(m,0,p);let h=i.createBuffer({size:20,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.INDIRECT|GPUBufferUsage.COPY_DST}),g=new Uint32Array([p.length,0,0,0,0]),v=i.createBuffer({size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),y=i.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});i.queue.writeBuffer(y,0,new Uint32Array([n,0,0,0]));let S=i.createShaderModule({code:b}),C=i.createShaderModule({code:x}),w=i.createComputePipeline({layout:`auto`,compute:{module:S,entryPoint:`main`}}),T=navigator.gpu.getPreferredCanvasFormat(),E=i.createRenderPipeline({layout:`auto`,vertex:{module:C,entryPoint:`vs`,buffers:[{arrayStride:12,attributes:[{shaderLocation:0,offset:0,format:`float32x3`}]},{arrayStride:12,attributes:[{shaderLocation:1,offset:0,format:`float32x3`}]}]},fragment:{module:C,entryPoint:`fs`,targets:[{format:T}]},primitive:{topology:`triangle-list`,cullMode:`back`},depthStencil:{format:`depth24plus`,depthWriteEnabled:!0,depthCompare:`less`}}),D=i.createBindGroup({layout:w.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:v}},{binding:1,resource:{buffer:o}},{binding:2,resource:{buffer:s}},{binding:3,resource:{buffer:h}},{binding:4,resource:{buffer:y}}]}),O=i.createBindGroup({layout:E.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:v}},{binding:1,resource:{buffer:s}}]}),k=e.domElement.getContext(`webgpu`);k.configure({device:i,format:T,alphaMode:`opaque`});let A=null,j=0,M=0;function N(e,t){A&&j===e&&M===t||(A?.destroy?.(),A=i.createTexture({size:[e,t],format:`depth24plus`,usage:GPUTextureUsage.RENDER_ATTACHMENT}),j=e,M=t)}function P(){let t=r();i.queue.writeBuffer(v,0,t),i.queue.writeBuffer(h,0,g);let a=e.domElement.width,o=e.domElement.height;N(a,o);let s=i.createCommandEncoder(),c=s.beginComputePass();c.setPipeline(w),c.setBindGroup(0,D),c.dispatchWorkgroups(Math.ceil(n/64)),c.end();let l=s.beginRenderPass({colorAttachments:[{view:k.getCurrentTexture().createView(),clearValue:{r:.02,g:.03,b:.05,a:1},loadOp:`clear`,storeOp:`store`}],depthStencilAttachment:{view:A.createView(),depthClearValue:1,depthLoadOp:`clear`,depthStoreOp:`store`}});l.setPipeline(E),l.setBindGroup(0,O),l.setVertexBuffer(0,d),l.setVertexBuffer(1,f),l.setIndexBuffer(m,`uint32`),l.drawIndexedIndirect(h,0),l.end(),i.queue.submit([s.finish()])}function F(){[o,s,d,f,m,h,v,y].forEach(e=>e.destroy()),A?.destroy?.()}return{frame:P,dispose:F}}function C(){return performance.memory?performance.memory.usedJSHeapSize:NaN}async function w(e,t,n,r){let{renderer:i,drawCallsOf:a}=r,o=0,s=0,c=0,l=0,u=C();for(let e=0;e<f+p;e++){let t=e>=f,r=performance.now();n(e);let u=performance.now()-r;if(t){o+=u,l=a();let e=i._benchGpuMs;Number.isFinite(e)&&e>0&&(s+=e,c++)}await new Promise(requestAnimationFrame)}let d=C();return{label:e,n:t,cpuMs:+(o/p).toFixed(3),gpuMs:c?+(s/c).toFixed(3):NaN,drawCalls:l,heapPerFrameKB:Number.isFinite(u)?+((d-u)/p/1024).toFixed(2):NaN}}function T(e){return[`| Config | N | CPU ms | GPU ms | Draw calls | Heap KB/frame |`,`|---|---:|---:|---:|---:|---:|`,...e.map(e=>`| ${e.label} | ${e.n} | ${e.cpuMs} | ${Number.isFinite(e.gpuMs)?e.gpuMs:`n/a`} | ${e.drawCalls} | ${Number.isFinite(e.heapPerFrameKB)?e.heapPerFrameKB:`n/a`} |`)].join(`
`)}async function E(){let t=document.createElement(`div`);t.style.cssText=`position:fixed;inset:0;background:#0a0d12;color:#cde;font:13px/1.5 monospace;z-index:99999;padding:16px;overflow:auto;white-space:pre-wrap`,t.textContent=`Phase 0 cull benchmark — initializing WebGPU…
`,document.body.appendChild(t);let a=e=>{t.textContent+=e+`
`,console.log(e)},s=document.createElement(`canvas`);s.width=1280,s.height=720;let u=new i({canvas:s,antialias:!1,trackTimestamp:!0});await u.init(),u.setSize(1280,720,!1),u._benchGpuMs=NaN;let f=!1,p=()=>{!u.backend?.trackTimestamp||f||(f=!0,u.resolveTimestampsAsync?.(`render`)?.then(e=>{Number.isFinite(e)&&e>=0&&(u._benchGpuMs=e)}).catch(()=>{}).finally(()=>{f=!1}))},m=new n,_=new l(60,1280/720,.5,4e3);m.add(new c(16777215,.4));let b=new e(16777215,1);b.position.set(1,1,1),m.add(b);let x=g(),C=new r({color:13402197,roughness:.8}),E=0,D=new o;function O(){E+=.01,_.position.set(Math.cos(E)*h,40,Math.sin(E)*h),_.lookAt(0,0,0),_.updateMatrixWorld()}function k(){return _.updateMatrixWorld(),D.multiplyMatrices(_.projectionMatrix,_.matrixWorldInverse),new Float32Array(D.elements)}let A=()=>u.info.render.drawCalls,j=[],M={renderer:u,drawCallsOf:A};for(let e of d){a(`\n=== N = ${e} ===`);{let t=v(m,x,C,e),n=await w(`baseline`,e,()=>{O(),u.render(m,_),p()},M);t.dispose(),j.push(n),a(`baseline   cpu=${n.cpuMs} gpu=${n.gpuMs} draws=${n.drawCalls}`)}{let t=y(m,x,C,e),n=await w(`instanced`,e,()=>{O(),u.render(m,_),p()},M);t.dispose(),j.push(n),a(`instanced  cpu=${n.cpuMs} gpu=${n.gpuMs} draws=${n.drawCalls}`)}{let t;try{t=await S(u,x,e,k);let n=await w(`gpucull`,e,()=>{O(),t.frame(),p()},M);t.dispose(),n.drawCalls=1,j.push(n),a(`gpucull    cpu=${n.cpuMs} gpu=${n.gpuMs} draws=1 (indirect)`)}catch(n){a(`gpucull    FAILED: ${n.message}`),j.push({label:`gpucull`,n:e,cpuMs:NaN,gpuMs:NaN,drawCalls:1,heapPerFrameKB:NaN}),t?.dispose?.()}}}let N=T(j);a(`

===== PHASE 0 RESULTS =====
`+N);let P={};j.forEach(e=>{P[`${e.label}:${e.n}`]=e});let F=[];for(let e of d){if(e<1e4)continue;let t=P[`baseline:${e}`],n=P[`instanced:${e}`],r=P[`gpucull:${e}`],i=e=>(e&&Number.isFinite(e.cpuMs)?e.cpuMs:0)+(e&&Number.isFinite(e.gpuMs)?e.gpuMs:0),a=i(t),o=i(r),s=i(n);o>0&&a/o>=2?F.push(`N=${e}: gpucull ${(a/o).toFixed(2)}× faster than baseline → PASS`):s>0&&o>0&&Math.abs(o-s)/s<.15?F.push(`N=${e}: gpucull≈instanced → win is instancing only`):F.push(`N=${e}: gpucull ${(a/Math.max(o,.001)).toFixed(2)}× vs baseline → below 2× gate`)}return a(`
===== GATE =====
`+F.join(`
`)),a(`
(Copy the RESULTS table into the plan file under "Phase 0 Results".)`),{rows:j,table:N,verdicts:F}}export{E as runCullBench};