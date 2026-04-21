import * as THREE from "three";

// Shared GPU uniforms referenced by multiple shader materials. Kept in
// this dependency-free module so scene, starfield, and billboard can all
// read and update the same values without introducing import cycles.

// Half the viewport height in CSS pixels. Drives physical-pixel sizing in
// the star shader. Updated on resize from scene.handleResize.
//
// The bloom pass temporarily widens both the camera fov and the composer
// render target by the same overscan factor, so this value can stay
// anchored to the visible viewport — the widening cancels exactly.
export const halfViewportPxUniform: THREE.IUniform<number> = {
  value: typeof window !== "undefined" ? window.innerHeight / 2 : 540,
};

// Target-relative coordinate frame for the star shader. Rather than
// using modelViewMatrix (where the view matrix's large translation
// component catastrophically cancels against large instance positions
// in Float32), the shader recomposes camera-space from three pieces
// computed CPU-side in a precision-safe way:
//
//   cameraSpace = uViewRotation · ((instancePos − uTarget) − uCameraOffset)
//
// All the Float32-risky subtractions now happen near zero. uTarget is
// the orbit focus (selected star's world position). uCameraOffset is
// the camera-to-target vector in world space. uViewRotation is the pure
// rotation portion of the view matrix.
export const starTargetUniform: THREE.IUniform<THREE.Vector3> = {
  value: new THREE.Vector3(0, 0, 0),
};
export const starCameraOffsetUniform: THREE.IUniform<THREE.Vector3> = {
  value: new THREE.Vector3(0, 0, 0),
};
export const starViewRotationUniform: THREE.IUniform<THREE.Matrix3> = {
  value: new THREE.Matrix3(),
};
