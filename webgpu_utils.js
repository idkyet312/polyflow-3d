export async function runWebGPUBenchmark(vertexCount) {
    if (!navigator.gpu) {
        console.warn("WebGPU not supported");
        return null;
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    const device = await adapter.requestDevice();

    // Data setup
    const data = new Float32Array(vertexCount * 3);
    for (let i = 0; i < data.length; i++) data[i] = Math.random();

    const gpuBuffer = device.createBuffer({
        size: data.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(gpuBuffer, 0, data);

    const shaderModule = device.createShaderModule({
        code: `
        @group(0) @binding(0) var<storage, read_write> data: array<f32>;
        @compute @workgroup_size(64)
        fn main(@builtin(global_invocation_id) id: vec3<u32>) {
            let index = id.x;
            if (index >= arrayLength(&data)) { return; }
            data[index] = data[index] * 2.0 + 1.0;
        }
        `
    });

    const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: {
            module: shaderModule,
            entryPoint: 'main',
        },
    });

    const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: gpuBuffer } }],
    });

    const commandEncoder = device.createCommandEncoder();
    const passEncoder = commandEncoder.beginComputePass();
    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.dispatchWorkgroups(Math.ceil(data.length / 64));
    passEncoder.end();

    const startTime = performance.now();
    device.queue.submit([commandEncoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    const endTime = performance.now();

    const gpuTime = endTime - startTime;

    // CPU comparison
    const cpuStartTime = performance.now();
    for (let i = 0; i < data.length; i++) {
        data[i] = data[i] * 2.0 + 1.0;
    }
    const cpuEndTime = performance.now();
    const cpuTime = cpuEndTime - cpuStartTime;

    return { gpuTime, cpuTime, speedup: cpuTime / gpuTime };
}
