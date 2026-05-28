# Clowns and Mimes, on Miscellaneous Topological Spaces... IN THE DARK

A team tag game played on a dimly lit labyrinth that wraps in unusual ways. You are either a mime or a clown. Tag every opponent before they tag you. The catch is that the playing field might be a torus, a Möbius strip, or a Klein bottle, and you can barely see.

## Status

Pre-alpha. The project is being built out in public.

## Download

Installers for Windows, macOS, and Linux are published on the [Releases page](https://github.com/sean-reid/clowns-and-mimes/releases). The project website at [sean-reid.github.io/clowns-and-mimes](https://sean-reid.github.io/clowns-and-mimes) always links to the latest build for your platform.

No build steps are required. Download, install, launch.

## How to play

1. Launch the game.
2. From the main menu pick one of:
   - **Host a game** to create a private arena and share a code with friends. As host you choose the topology.
   - **Enter a code** to join a friend's private arena.
   - **Play against internet strangers** to be matched into an open lobby with a random topology.
3. All players start in the center of the labyrinth. You get one minute to move around without tagging anyone.
4. Turns rotate between the mime team and the clown team. Whoever has the active turn can freeze opponents by tagging them. Frozen players stay frozen until a teammate unfreezes them.
5. Win by freezing every opponent on the other team.

## Controls

| Action         | Input                                          |
| -------------- | ---------------------------------------------- |
| Move           | WASD                                           |
| Look           | Mouse                                          |
| Sprint         | Hold Shift                                     |
| Jump           | Space                                          |
| Tag / unfreeze | Run into the other player (no button required) |
| Menu           | Esc (world keeps running)                      |

## Repository layout

```
game/         Godot 4 client (GDScript)
backend/      Cloudflare Workers and Durable Objects (TypeScript)
website/      Astro static site published to GitHub Pages
docs/         Architecture and contributor docs
.github/      CI, CD, issue templates
```

The full architecture, including diagrams, lives in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, branch hygiene, commit format, and the PR workflow. By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
