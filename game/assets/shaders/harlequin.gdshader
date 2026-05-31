shader_type canvas_item;

uniform vec4 color_a : source_color = vec4(0.07, 0.05, 0.09, 1.0);
uniform vec4 color_b : source_color = vec4(0.13, 0.09, 0.15, 1.0);
uniform float scale = 10.0;

void fragment() {
	vec2 p = UV * scale;
	// Rotate the grid 45 degrees so the checker reads as a diamond harlequin.
	vec2 r = vec2(p.x + p.y, p.x - p.y);
	float c = mod(floor(r.x) + floor(r.y), 2.0);
	COLOR = mix(color_a, color_b, c);
}
