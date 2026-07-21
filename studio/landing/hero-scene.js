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

  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x080c10, 0.075);
  const camera = new THREE.PerspectiveCamera(31, 1, 0.1, 100);
  camera.position.set(0.15, 0.05, 8.2);

  const rig = new THREE.Group();
  rig.rotation.set(-0.12, 0.28, -0.05);
  scene.add(rig);

  const metal = new THREE.MeshStandardMaterial({
    color: 0x9eabb1,
    metalness: 0.94,
    roughness: 0.23,
  });
  const darkMetal = new THREE.MeshStandardMaterial({
    color: 0x0b1116,
    metalness: 0.8,
    roughness: 0.31,
  });
  const cyan = new THREE.MeshStandardMaterial({
    color: 0x3ec5cf,
    emissive: 0x167680,
    emissiveIntensity: 2.4,
    metalness: 0.38,
    roughness: 0.22,
  });

  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.45, 0.15, 20, 120), metal);
  rig.add(ring);
  const innerRing = new THREE.Mesh(new THREE.TorusGeometry(1.92, 0.035, 12, 100), cyan);
  innerRing.position.z = 0.08;
  rig.add(innerRing);

  const segments = [];
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const segment = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.075, 0.16), i % 2 ? darkMetal : metal);
    segment.position.set(Math.cos(angle) * 2.12, Math.sin(angle) * 2.12, 0.02);
    segment.rotation.z = angle + Math.PI / 2;
    rig.add(segment);
    segments.push(segment);
  }

  const heights = [1.05, 2.15, 3.15, 2.15, 1.05];
  const bars = [];
  heights.forEach((height, index) => {
    const bar = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, height, 8, 16), cyan);
    bar.position.set((index - 2) * 0.55, 0, 0.28);
    rig.add(bar);
    bars.push(bar);
  });

  const playShape = new THREE.Shape();
  playShape.moveTo(-0.45, -0.68);
  playShape.lineTo(-0.45, 0.68);
  playShape.lineTo(0.72, 0);
  playShape.closePath();
  const play = new THREE.Mesh(new THREE.ExtrudeGeometry(playShape, { depth: 0.16, bevelEnabled: true, bevelSize: 0.035, bevelThickness: 0.04, bevelSegments: 3 }), darkMetal);
  play.position.set(0.03, 0, 0.52);
  rig.add(play);

  const record = new THREE.Mesh(new THREE.SphereGeometry(0.11, 24, 24), cyan);
  record.position.set(2.12, 1.62, 0.18);
  rig.add(record);
  const recordLight = new THREE.PointLight(0x3ec5cf, 16, 2.4, 1.7);
  recordLight.position.copy(record.position);
  rig.add(recordLight);

  const dustCount = 420;
  const dustPosition = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i++) {
    dustPosition[i * 3] = (Math.random() - 0.5) * 13;
    dustPosition[i * 3 + 1] = (Math.random() - 0.5) * 9;
    dustPosition[i * 3 + 2] = (Math.random() - 0.5) * 7 - 1.8;
  }
  const dustGeometry = new THREE.BufferGeometry();
  dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPosition, 3));
  const dustMaterial = new THREE.PointsMaterial({ color: 0x9ab1b8, size: 0.018, transparent: true, opacity: 0.34, depthWrite: false });
  const dust = new THREE.Points(dustGeometry, dustMaterial);
  scene.add(dust);

  scene.add(new THREE.HemisphereLight(0xb7e4e7, 0x071014, 1.65));
  const key = new THREE.DirectionalLight(0xffffff, 4.2);
  key.position.set(-3.5, 4, 5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x3ec5cf, 4.8);
  rim.position.set(4, -2, 2);
  scene.add(rim);

  const pointer = { x: 0, y: 0 };
  const onPointerMove = (event) => {
    pointer.x = (event.clientX / innerWidth - 0.5) * 2;
    pointer.y = (event.clientY / innerHeight - 0.5) * 2;
  };
  addEventListener('pointermove', onPointerMove, { passive: true });

  let width = 0;
  let height = 0;
  const resize = () => {
    const bounds = canvas.getBoundingClientRect();
    width = Math.max(1, Math.round(bounds.width));
    height = Math.max(1, Math.round(bounds.height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  resize();

  const clock = new THREE.Clock();
  let frame = 0;
  let running = !document.hidden;
  const render = () => {
    if (!running) return;
    const elapsed = clock.getElapsedTime();
    const scrollProgress = Math.min(scrollY / Math.max(innerHeight, 1), 1.4);
    rig.rotation.y += ((0.25 + pointer.x * 0.11 + scrollProgress * 0.3) - rig.rotation.y) * 0.035;
    rig.rotation.x += ((-0.1 - pointer.y * 0.07 + scrollProgress * 0.08) - rig.rotation.x) * 0.035;
    rig.rotation.z = -0.05 + Math.sin(elapsed * 0.23) * 0.018;
    rig.position.y = Math.sin(elapsed * 0.48) * 0.07;
    ring.rotation.z = elapsed * 0.035;
    innerRing.rotation.z = -elapsed * 0.055;
    segments.forEach((segment, index) => { segment.position.z = 0.02 + Math.sin(elapsed * 0.7 + index) * 0.035; });
    bars.forEach((bar, index) => { bar.scale.y = 1 + Math.sin(elapsed * 1.15 + index * 0.62) * 0.035; });
    record.scale.setScalar(1 + Math.sin(elapsed * 2.3) * 0.12);
    dust.rotation.y = elapsed * 0.008;
    renderer.render(scene, camera);
    frame = requestAnimationFrame(render);
  };

  const onVisibility = () => {
    running = !document.hidden;
    if (running) {
      clock.getDelta();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(render);
    } else {
      cancelAnimationFrame(frame);
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  render();

  return {
    destroy() {
      running = false;
      cancelAnimationFrame(frame);
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
