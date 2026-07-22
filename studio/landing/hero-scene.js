const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js';

export async function mountHeroScene(canvas) {
  let THREE;
  try {
    THREE = await import(THREE_URL);
  } catch {
    return null;
  }

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
  } catch {
    return null;
  }

  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x080c10, 0.082);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(0, 0, 9.4);

  const rig = new THREE.Group();
  rig.rotation.set(-0.09, -0.24, 0.025);
  scene.add(rig);

  const silver = new THREE.MeshStandardMaterial({ color: 0x9cacb1, metalness: 0.94, roughness: 0.22 });
  const graphite = new THREE.MeshStandardMaterial({ color: 0x0b1116, metalness: 0.78, roughness: 0.34 });
  const signal = new THREE.MeshStandardMaterial({ color: 0x3ec5cf, emissive: 0x16727b, emissiveIntensity: 2.2, metalness: 0.32, roughness: 0.2 });
  const amber = new THREE.MeshStandardMaterial({ color: 0xd99a3d, emissive: 0x8b5012, emissiveIntensity: 1.4, roughness: 0.28 });

  const outer = new THREE.Shape();
  outer.moveTo(-1.72, -1.82);
  outer.lineTo(1.3, -1.82);
  outer.lineTo(1.83, -1.3);
  outer.lineTo(1.83, 1.24);
  outer.lineTo(1.25, 1.82);
  outer.lineTo(-1.72, 1.82);
  outer.lineTo(-2.05, 1.48);
  outer.lineTo(-2.05, -1.48);
  outer.closePath();
  const opening = new THREE.Path();
  opening.moveTo(-1.54, -1.31);
  opening.lineTo(1.04, -1.31);
  opening.lineTo(1.31, -1.04);
  opening.lineTo(1.31, .98);
  opening.lineTo(.98, 1.31);
  opening.lineTo(-1.54, 1.31);
  opening.closePath();
  outer.holes.push(opening);

  const frame = new THREE.Mesh(new THREE.ExtrudeGeometry(outer, { depth: .18, bevelEnabled: true, bevelSize: .04, bevelThickness: .05, bevelSegments: 3 }), silver);
  frame.position.z = -.1;
  rig.add(frame);

  const backplate = new THREE.Mesh(new THREE.BoxGeometry(3.02, 2.6, .12), graphite);
  backplate.position.set(-.25, 0, -.2);
  rig.add(backplate);

  const heights = [.62, 1.42, 2.26, 1.34, .58];
  const bars = [];
  heights.forEach((height, index) => {
    const bar = new THREE.Mesh(new THREE.CapsuleGeometry(.105, height, 7, 14), signal);
    bar.position.set(-1.02 + index * .39, 0, .22);
    rig.add(bar);
    bars.push(bar);
  });

  const cornerA = new THREE.Mesh(new THREE.BoxGeometry(.62, .055, .06), signal);
  cornerA.position.set(-1.74, -1.3, .25);
  rig.add(cornerA);
  const cornerB = cornerA.clone();
  cornerB.position.set(1.31, 1.25, .25);
  rig.add(cornerB);

  const record = new THREE.Mesh(new THREE.SphereGeometry(.075, 20, 20), amber);
  record.position.set(1.47, -1.48, .25);
  rig.add(record);

  const pageMaterial = new THREE.MeshStandardMaterial({ color: 0xb8c5c8, transparent: true, opacity: .16, metalness: .2, roughness: .7, side: THREE.DoubleSide });
  const pageGroup = new THREE.Group();
  pageGroup.position.set(-2.55, .05, -.7);
  rig.add(pageGroup);
  for (let i = 0; i < 4; i++) {
    const page = new THREE.Mesh(new THREE.PlaneGeometry(.95, 1.3), pageMaterial);
    page.position.set(-i * .23, (i - 1.5) * .17, -i * .2);
    page.rotation.set(.04 * i, -.38, -.08 + i * .035);
    pageGroup.add(page);
    for (let line = 0; line < 4; line++) {
      const textLine = new THREE.Mesh(new THREE.BoxGeometry(.55 - line * .04, .018, .012), graphite);
      textLine.position.set(-i * .23, .38 - line * .17 + (i - 1.5) * .17, .02 - i * .2);
      textLine.rotation.copy(page.rotation);
      pageGroup.add(textLine);
    }
  }

  const stemGroup = new THREE.Group();
  stemGroup.position.set(2.35, 0, -.7);
  rig.add(stemGroup);
  for (let i = 0; i < 4; i++) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(1.15, .12, .07), i === 2 ? amber : signal);
    rail.position.set(i * .22, .56 - i * .38, -i * .18);
    rail.rotation.y = .28;
    rail.material = rail.material.clone();
    rail.material.transparent = true;
    rail.material.opacity = .3 + i * .1;
    stemGroup.add(rail);
  }

  const dustCount = 260;
  const positions = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i++) {
    positions[i * 3] = (Math.random() - .5) * 11;
    positions[i * 3 + 1] = (Math.random() - .5) * 8;
    positions[i * 3 + 2] = (Math.random() - .5) * 6 - 1.5;
  }
  const dustGeometry = new THREE.BufferGeometry();
  dustGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const dust = new THREE.Points(dustGeometry, new THREE.PointsMaterial({ color: 0x93aeb2, size: .015, transparent: true, opacity: .27, depthWrite: false }));
  scene.add(dust);

  scene.add(new THREE.HemisphereLight(0xc9f7f4, 0x061014, 1.55));
  const key = new THREE.DirectionalLight(0xffffff, 4.6);
  key.position.set(-3.5, 4, 5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x3ec5cf, 5.2);
  rim.position.set(4, -2, 3);
  scene.add(rim);

  const pointer = { x: 0, y: 0 };
  const onPointerMove = (event) => {
    pointer.x = (event.clientX / innerWidth - .5) * 2;
    pointer.y = (event.clientY / innerHeight - .5) * 2;
  };
  addEventListener('pointermove', onPointerMove, { passive: true });

  const resize = () => {
    const bounds = canvas.getBoundingClientRect();
    renderer.setSize(Math.max(1, Math.round(bounds.width)), Math.max(1, Math.round(bounds.height)), false);
    camera.aspect = Math.max(bounds.width, 1) / Math.max(bounds.height, 1);
    camera.updateProjectionMatrix();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  resize();

  const clock = new THREE.Clock();
  let frameId = 0;
  let running = !document.hidden;
  const render = () => {
    if (!running) return;
    const time = clock.getElapsedTime();
    const scroll = Math.min(scrollY / Math.max(innerHeight, 1), 1.2);
    rig.rotation.y += ((-.22 + pointer.x * .1 + scroll * .22) - rig.rotation.y) * .035;
    rig.rotation.x += ((-.08 - pointer.y * .055 + scroll * .06) - rig.rotation.x) * .035;
    rig.rotation.z = .025 + Math.sin(time * .24) * .012;
    rig.position.y = Math.sin(time * .42) * .055;
    bars.forEach((bar, index) => { bar.scale.y = 1 + Math.sin(time * 1.25 + index * .65) * .04; });
    pageGroup.position.x = -2.55 + Math.sin(time * .32) * .08;
    stemGroup.position.x = 2.35 + Math.sin(time * .28 + 1.2) * .07;
    record.scale.setScalar(1 + Math.sin(time * 2.5) * .13);
    dust.rotation.y = time * .006;
    renderer.render(scene, camera);
    frameId = requestAnimationFrame(render);
  };

  const onVisibility = () => {
    running = !document.hidden;
    cancelAnimationFrame(frameId);
    if (running) frameId = requestAnimationFrame(render);
  };
  document.addEventListener('visibilitychange', onVisibility);
  render();

  return {
    destroy() {
      running = false;
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('visibilitychange', onVisibility);
      scene.traverse((object) => {
        object.geometry?.dispose?.();
        if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
        else object.material?.dispose?.();
      });
      renderer.dispose();
    },
  };
}
