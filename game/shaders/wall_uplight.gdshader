// Wall surface + strip light. The wall is one contiguous rough surface: a
// fine procedural fbm noise (sampled in world space so it carries across wall
// joints with no seams or tiling) modulates albedo and roughness, giving a
// matte plaster/concrete feel rather than a flat panel. A crisp emissive band
// runs horizontally along the wall-floor junction, like the recessed LED light
// lines of a Portal-style test chamber - full emission at the base, fading out
// a short way up the wall. The maze has no ceiling, so the strip lives at the
// floor rather than the open top. A global phase tint (driven by a Tween in
// labyrinth.gd) shifts the strip's hue warm/cool with the active turn.
// Per-fragment so Klein/Möbius geometry needs no special handling.

shader_type spatial;

uniform vec3 base_albedo : source_color = vec3(0.20, 0.21, 0.25);
uniform float roughness_val = 0.92;
// World-space frequency of the surface noise and how much it pushes albedo /
// roughness around their base values.
uniform float noise_scale = 2.2;
uniform float albedo_variation = 0.16;
uniform float roughness_variation = 0.12;
// Strip color. Crisp white default; tint_color crossfades it per phase.
uniform vec3 glow_color : source_color = vec3(1.0, 1.0, 1.0);
uniform vec3 tint_color : source_color = vec3(1.0, 1.0, 1.0);
uniform float glow_intensity = 4.0;
// Wall half-height in object space (WALL_HEIGHT / 2). The box mesh is centered
// on its origin so the bottom face sits at -half_height; height_above_base is
// then metres up from the floor.
uniform float half_height = 3.0;
// Strip placement, in metres above the floor. The strip sits at the wall-floor
// intersection: centre at the floor line, so the visible band runs from the
// junction up by strip_half_width, with a soft top edge.
uniform float strip_center = 0.0;
uniform float strip_half_width = 0.1;
uniform float strip_edge = 0.06;

varying float height_above_base;
varying vec3 world_pos;

float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
    float sum = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 4; i++) {
        sum += amp * vnoise(p);
        p *= 2.0;
        amp *= 0.5;
    }
    return sum;
}

void vertex() {
    height_above_base = VERTEX.y + half_height;
    world_pos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

void fragment() {
    // Contiguous rough surface. Project world position to a 2D coord that runs
    // along horizontal travel and up the wall, so the grain is continuous
    // across adjacent wall segments.
    vec2 nc = vec2(world_pos.x + world_pos.z, world_pos.y) * noise_scale;
    float n = fbm(nc);
    ALBEDO = base_albedo * (1.0 - albedo_variation * 0.5 + albedo_variation * n);
    ROUGHNESS = clamp(roughness_val + (n - 0.5) * roughness_variation, 0.0, 1.0);
    // A defined strip light: full strength between center +/- half_width, soft
    // edges. Independent of the surface noise so the light line stays crisp.
    float lower = smoothstep(
        strip_center - strip_half_width - strip_edge,
        strip_center - strip_half_width,
        height_above_base);
    float upper = 1.0 - smoothstep(
        strip_center + strip_half_width,
        strip_center + strip_half_width + strip_edge,
        height_above_base);
    float strip = lower * upper;
    EMISSION = glow_color * tint_color * (glow_intensity * strip);
}
