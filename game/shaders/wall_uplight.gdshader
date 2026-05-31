// Wall base uplighting. A thin emissive band along the bottom of each maze
// wall so depth reads at distance: the band glows brightest at the floor and
// falls off ~3 m up the wall, leaving the upper wall its plain albedo. A
// global phase tint (driven by a Tween in labyrinth.gd) shifts the glow's
// hue warm/cool with the active turn. Per-fragment so Klein/Möbius geometry
// needs no special handling - the band tracks VERTEX.y in object space, which
// is the same fraction of WALL_HEIGHT on every wall regardless of length.

shader_type spatial;

uniform vec3 base_albedo : source_color = vec3(0.18, 0.18, 0.22);
uniform float roughness_val = 0.85;
// Glow color. White-gold default; tint_color crossfades it per phase.
uniform vec3 glow_color : source_color = vec3(1.0, 0.93, 0.78);
uniform vec3 tint_color : source_color = vec3(1.0, 1.0, 1.0);
uniform float glow_intensity = 1.5;
// Wall half-height in object space (WALL_HEIGHT / 2). The box mesh is centered
// on its origin so the bottom face sits at -half_height. Falloff height is the
// distance up from the floor over which the glow fades to nothing.
uniform float half_height = 3.0;
uniform float falloff_height = 3.0;

varying float height_above_base;

void vertex() {
    height_above_base = VERTEX.y + half_height;
}

void fragment() {
    ALBEDO = base_albedo;
    ROUGHNESS = roughness_val;
    // 1.0 at the floor, easing to 0 by falloff_height up the wall.
    float t = clamp(height_above_base / falloff_height, 0.0, 1.0);
    float band = 1.0 - smoothstep(0.0, 1.0, t);
    EMISSION = glow_color * tint_color * (glow_intensity * band);
}
