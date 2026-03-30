# Drake - Stellar Neighborhood Viewer

An interactive 3D visualization of the stars nearest to our Sun, built to help
people explore and understand our local stellar neighborhood.

The name references the [Drake Equation](https://en.wikipedia.org/wiki/Drake_equation),
which estimates the number of communicative civilizations in our galaxy — a question
that starts with knowing what's nearby.

**[Live demo](https://drake-wine.vercel.app)**

## What you're looking at

The viewer displays the 300 nearest stars to Sol, plotted at their real
three-dimensional positions using data from the
[HYG Database](https://github.com/astronexus/HYG-Database) (v4.2). Coordinates
are in parsecs (1 parsec ~ 3.26 light-years). Star colors are derived from their
[B-V color index](https://en.wikipedia.org/wiki/Color_index) — blue stars are
hot, red stars are cool — and sizes reflect luminosity on a logarithmic scale.

The flat grid represents the
[galactic plane](https://en.wikipedia.org/wiki/Galactic_plane), the disk of the
Milky Way. Its opacity fades with distance from the selected star. The vertical
drop lines show how far above or below this plane each star sits.

## Controls

| Input | Action |
|---|---|
| Drag | Rotate around the focused star |
| Option+drag or scroll | Zoom in/out |
| Click star or label | Focus camera on that star |
| `/` | Search for a star by name |
| `L` | Toggle star labels |
| `G` | Toggle galactic plane grid |

Hovering over a star shows its designations, distance, magnitude, spectral type,
and luminosity. When a star other than Sol is selected, the tooltip also shows
the distance from the selected star.

## How stars are named

Stars accumulate names over centuries of cataloging. A single star might be known
by a traditional name, a Greek-letter designation, and several catalog numbers.
This viewer picks the most recognizable name as the primary label and lists
alternatives in the hover tooltip.

The naming priority, from most to least familiar:

### 1. IAU proper names

The International Astronomical Union maintains an
[official list of proper star names](https://en.wikipedia.org/wiki/List_of_proper_names_of_stars)
— traditional names standardized for modern use. Examples: **Sirius**, **Proxima
Centauri**, **Barnard's Star**.

### 2. Bayer designations

Introduced by Johann Bayer in 1603, these combine a Greek letter (roughly
indicating brightness) with the Latin
[genitive form](https://en.wikipedia.org/wiki/IAU_designated_constellations#Constellations)
of the constellation name. Examples: **Alpha Centauri**, **Epsilon Eridani**,
**Tau Ceti**. See [Bayer designation](https://en.wikipedia.org/wiki/Bayer_designation).

### 3. Flamsteed designations

From John Flamsteed's 1712 catalog, these assign a number (by right ascension
within the constellation) plus the constellation's genitive. Example: **61
Cygni**. See [Flamsteed designation](https://en.wikipedia.org/wiki/Flamsteed_designation).

### 4. Gliese catalog

Wilhelm Gliese's [Catalogue of Nearby Stars](https://en.wikipedia.org/wiki/Gliese_Catalogue_of_Nearby_Stars)
covers all known stars within 25 parsecs of the Sun. Designations use **Gl** or
**GJ** followed by a number (e.g., **Gl 551** = Proxima Centauri). Component
letters are included for multi-star systems (e.g., **Gl 65A**, **Gl 65B**).

### 5. Hipparcos catalog

The ESA [Hipparcos satellite](https://en.wikipedia.org/wiki/Hipparcos_catalogue)
(1989-1993) produced high-precision positions for 118,218 stars. Designated by
**HIP** number (e.g., **HIP 70890**).

### 6. Henry Draper catalog

A spectral classification catalog of over 225,000 stars, published 1918-1924 by
Harvard College Observatory. Designated by **HD** number (e.g., **HD 128620**).
See [Henry Draper Catalogue](https://en.wikipedia.org/wiki/Henry_Draper_Catalogue).

### Multi-star systems

Many nearby stars are binaries or higher multiples. Component letters (A, B, C)
are appended to distinguish members. When each component has its own unique IAU
name (e.g., **Rigil Kentaurus** and **Toliman** for Alpha Centauri A and B), no
suffix is added. When components share a name or inherit one from the primary,
suffixes are used (e.g., **Sirius** and **Sirius B**).

## Data source

Star data comes from the [HYG Database v4.2](https://codeberg.org/astronexus/hyg)
by David Nash, which merges the Hipparcos, Yale Bright Star, and Gliese catalogs.
Licensed under [CC-BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

The extraction script (`scripts/extract-stars.py`) selects the 300 nearest stars,
resolves names using the hierarchy above, and outputs `src/stars.json`.

## Development

```sh
bun install
bun run dev     # dev server with HMR at http://localhost:3000
bun run build   # static build to dist/
```

### Updating star data

```sh
curl -L -o hyg_v42.csv.gz \
  "https://codeberg.org/astronexus/hyg/media/branch/main/data/hyg/CURRENT/hyg_v42.csv.gz"
gunzip hyg_v42.csv.gz
python3 scripts/extract-stars.py hyg_v42.csv src/stars.json
```

### Deploying

Hosted on Vercel as a static site. Deploy with:

```sh
bunx vercel --prod
```

## Stack

- **Runtime/bundler:** [Bun](https://bun.sh)
- **3D rendering:** [Three.js](https://threejs.org) with CSS2DRenderer for labels
  and a custom ShaderMaterial for the grid fade effect
- **Hosting:** [Vercel](https://vercel.com)
