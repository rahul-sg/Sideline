import { useThree } from '@react-three/fiber';
import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { FIELD_LEN, FIELD_W } from '../lib/playMath';
import { team } from '../lib/teams';
import { markingsTexture, turfTexture, type EndZoneStyle } from './textures';

function endZone(abbr: string | null): EndZoneStyle {
  if (!abbr) return { fill: 'rgba(30,70,40,0.0)', text: 'rgba(255,255,255,0.0)', stroke: 'rgba(0,0,0,0)', label: '' };
  const t = team(abbr);
  return { fill: t.primary, text: '#ffffff', stroke: t.secondary, label: t.nick };
}

/** Wait for the display font so canvas-drawn numbers use it. */
function useFontsReady() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.all([
      document.fonts.load('800 100px "Barlow Condensed"'),
      document.fonts.load('700 100px "Barlow Condensed"'),
    ])
      .catch(() => undefined)
      .then(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, []);
  return ready;
}

export function Field({ home }: { home: string | null }) {
  const gl = useThree((s) => s.gl);
  const aniso = gl.capabilities.getMaxAnisotropy();
  const fontsReady = useFontsReady();

  const fieldTurf = useMemo(() => {
    const t = turfTexture(true, aniso);
    t.repeat.set(FIELD_LEN / 10, FIELD_W / 10);
    return t;
  }, [aniso]);
  const apronTurf = useMemo(() => {
    const t = turfTexture(false, aniso);
    t.repeat.set(220 / 10, 130 / 10);
    return t;
  }, [aniso]);

  const markings = useMemo(
    () => (fontsReady ? markingsTexture([endZone(home), endZone(home)], aniso) : null),
    [fontsReady, home, aniso],
  );
  useEffect(() => () => markings?.texture.dispose(), [markings]);

  return (
    <group>
      {/* Sideline apron and surround */}
      <mesh rotation-x={-Math.PI / 2} position-y={-0.01} receiveShadow>
        <planeGeometry args={[220, 130]} />
        <meshStandardMaterial map={apronTurf} color="#7c8f78" roughness={0.97} />
      </mesh>
      {/* Field of play, mowing stripes every 5 yards */}
      <mesh rotation-x={-Math.PI / 2} position-y={0} receiveShadow>
        <planeGeometry args={[FIELD_LEN, FIELD_W]} />
        <meshStandardMaterial map={fieldTurf} roughness={0.93} />
      </mesh>
      {markings && (
        <mesh rotation-x={-Math.PI / 2} position-y={0.006} receiveShadow renderOrder={1}>
          <planeGeometry args={[markings.width, markings.depth]} />
          <meshStandardMaterial
            map={markings.texture}
            transparent
            depthWrite={false}
            roughness={0.9}
            polygonOffset
            polygonOffsetFactor={-2}
          />
        </mesh>
      )}
      <Sideline />
    </group>
  );
}

/** Team-area benches, coaching boxes and the padded wall line along both sidelines. */
function Sideline() {
  const benchMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#1b1f27', roughness: 0.7 }), []);
  return (
    <group>
      {[1, -1].map((side) => (
        <group key={side}>
          {/* Coaching box line (6 ft off the field) */}
          <mesh rotation-x={-Math.PI / 2} position={[0, 0.004, side * (FIELD_W / 2 + 4)]}>
            <planeGeometry args={[50, 0.12]} />
            <meshBasicMaterial color="#e8d34a" toneMapped={false} transparent opacity={0.55} />
          </mesh>
          {/* Benches */}
          {[-18, -6, 6, 18].map((x) => (
            <mesh key={x} position={[x, 0.3, side * (FIELD_W / 2 + 9.5)]} castShadow receiveShadow material={benchMat}>
              <boxGeometry args={[10, 0.6, 1]} />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}
