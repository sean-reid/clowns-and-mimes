// Avatar head: face texture on the front hemisphere, solid team color on the
// back hemisphere with a short blend zone between them. The SphereMesh's
// default UV unwrap runs longitude across U (0..1) and latitude across V; U
// 0.0 sits at the back seam, U 0.5 is the front-facing meridian, U 1.0
// returns to the back seam. The half-width of the face zone is set by
// FACE_HALF_WIDTH; outside it the back_color fills.

shader_type spatial;
render_mode cull_disabled;

uniform sampler2D face_texture : source_color, filter_linear, repeat_disable;
uniform vec3 back_color : source_color = vec3(0.3, 0.05, 0.1);

const float FACE_HALF_WIDTH = 0.25;
const float FACE_EDGE_SOFTNESS = 0.04;

void fragment() {
    // Distance along the equator from the front meridian (U = 0.5), wrapped
    // so the back seam is the far side. Result is 0 at the front and 0.5 at
    // the back.
    float u_from_front = abs(UV.x - 0.5);
    float face_factor = 1.0 - smoothstep(FACE_HALF_WIDTH - FACE_EDGE_SOFTNESS, FACE_HALF_WIDTH + FACE_EDGE_SOFTNESS, u_from_front);

    vec4 face = texture(face_texture, UV);
    ALBEDO = mix(back_color, face.rgb, face_factor);
    ROUGHNESS = 0.7;
}
