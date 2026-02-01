# Ape Island AI

A pixelated 250x200 web simulation where an AI ape learns to survive predators on an island.
You can talk to the ape to bias its decisions and help it avoid danger.

## Run locally

Any static server works. Examples:

```bash
python -m http.server
```

Then open `http://localhost:8000`.


## Files

- `index.html` - layout and UI
- `styles.css` - pixel-art presentation
- `main.js` - simulation, learning loop, and chat guidance
- `vercel.json` - static deployment config
