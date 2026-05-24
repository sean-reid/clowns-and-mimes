// Avatar head: the full face image cropped to a face-shaped ellipse on the
// front of the head, solid team color filling the rest. The SphereMesh's
// default UV unwrap runs longitude across U (0..1) and latitude across V;
// U=0.5 is the forward meridian, V=0.5 is the equator. The whole face
// texture (not just its center) is rescaled to fit inside the ellipse, so
// the player sees an actual face on the head, not a tiny crop of one.

shader_type spatial;
// Default back-face culling stays on. The local player's camera sits inside
// the head sphere; disabling cull would render the inside of the face every
// frame and blot out the world.

uniform sampler2D face_texture : source_color, filter_linear, repeat_disable;
uniform vec3 back_color : source_color = vec3(0.3, 0.05, 0.1);

// Ellipse half-axes in UV space, in (longitude, latitude) units. Taller
// than wide so the patch reads as a face shape rather than a circle.
const float FACE_U_HALF = 0.22;
const float FACE_V_HALF = 0.30;
const float FACE_EDGE_SOFTNESS = 0.05;

void fragment() {
    // Normalized distance from (U=0.5, V=0.5) in ellipse-half-axis units.
    // Outside length 1.0, the back color takes over.
    vec2 d = vec2((UV.x - 0.5) / FACE_U_HALF, (UV.y - 0.5) / FACE_V_HALF);
    float dist = length(d);
    float face_factor = 1.0 - smoothstep(1.0 - FACE_EDGE_SOFTNESS, 1.0 + FACE_EDGE_SOFTNESS, dist);

    // Remap the sphere's UV onto the texture so the full face image fits
    // inside the ellipse's bounding box. Without this, we'd sample only the
    // small middle slice of the texture and waste most of the face image.
    vec2 patch_uv = vec2(
        (UV.x - (0.5 - FACE_U_HALF)) / (2.0 * FACE_U_HALF),
        (UV.y - (0.5 - FACE_V_HALF)) / (2.0 * FACE_V_HALF)
    );
    vec4 face = texture(face_texture, patch_uv);
    ALBEDO = mix(back_color, face.rgb, face_factor);
    ROUGHNESS = 0.7;
}
