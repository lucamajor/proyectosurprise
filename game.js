/* =============================================================================
 * KITTY RUNNER — an infinite runner in the spirit of the Chrome dinosaur.
 * Vanilla ES6 + Canvas2D. Zero dependencies.
 *
 * FILE MAP
 *   1. GameConfig .... every tunable number lives here (edit this, nothing else)
 *   2. Utils ......... tiny math helpers + the AABB collision test
 *   3. Sprite ........ rendering abstraction: image -> emoji -> solid color
 *   4. Entity ........ base class: position, size, hitbox, update/draw
 *   5. Player ........ the red & white kitten + jump physics
 *   6. Obstacle / Collectible / Particle / FloatingText / Cloud
 *   7. Game .......... loop, delta time, spawning, collisions, states, resize
 *   8. Bootstrap ..... input wiring + start
 *
 * TWO SYSTEMS ARE DOCUMENTED IN DETAIL BELOW (see the big comment blocks):
 *   - Jump physics ......... in Player.update()
 *   - Rectangular collision  in Utils.intersects() and Entity.getHitbox()
 * ========================================================================== */

'use strict';

/* =============================================================================
 * 1. CONFIG — the only place you should need to touch to re-balance the game.
 *
 * IMPORTANT — "design pixels":
 * Every size/speed below is expressed in *design pixels*, measured against a
 * reference screen height of `world.designHeight`. At runtime the Game computes
 * a single `scale` factor from the real canvas height and multiplies everything
 * by it. That is why the game feels identical on a 4K monitor and on a Galaxy
 * S24: the kitten is always the same *fraction* of the screen.
 * ========================================================================== */
const GameConfig = {

  world: {
    // The two reference dimensions every number below is measured against.
    designWidth: 920,
    designHeight: 860,

    /* TWO SCALES, ON PURPOSE.
     *
     * SIZE scale = min(width/designWidth, height/designHeight), clamped.
     *   Drives every size and the vertical physics. It has to include *width*:
     *   a jump only carries the kitten `speed * airtime` pixels forward, and it
     *   must clear its own body plus the obstacle. If the kitten were sized from
     *   height alone it would be ~22% of a portrait phone's width and no jump
     *   could ever span it — the classic "unplayable on mobile" bug.
     *
     * MOTION scale = width/designWidth, clamped.
     *   Drives horizontal speed and spawn gaps, so "seconds of warning" before
     *   an obstacle stays roughly constant from a Galaxy S24 to an ultrawide.
     *
     * Rule of thumb when re-tuning: keep jump distance (speed*speedScale*airtime)
     * at ~3x the kitten's width, and the reaction window above ~1s at base speed.
     */
    /* The two floors are raised together, and that pairing is the whole trick.
     * A phone sits at both minimums, so `minScale` alone decides how big the
     * kitten looks there — but a jump only carries it `speed*speedScale*airtime`
     * pixels forward, and airtime is scale-invariant. Enlarge the world without
     * also raising `minSpeedScale` and the jump stops being able to span the
     * (now wider) kitten plus obstacle. Binding case is the double crate:
     * keep jump distance above ~2x (kitten + widest obstacle). */
    minScale: 0.91,
    maxScale: 1.70,
    minSpeedScale: 0.95,
    maxSpeedScale: 1.45,

    /* Ground line, as a fraction of canvas height.
     * On a very tall phone (a Galaxy S24 is 412x915 -> aspect 2.22) pinning the
     * ground near the bottom leaves ~84% empty sky and shoves all the action
     * into the last sixth of the screen. `groundRatioTall` lifts it so the
     * kitten, obstacles and cupcakes sit near the vertical middle. The value is
     * eased in between `tallFrom` and `tallTo` so a device sitting near the
     * boundary doesn't snap between two very different layouts. */
    groundRatio: 0.80,          // normal / squarish screens
    groundRatioLandscape: 0.86, // pushed lower on short/wide screens
    groundRatioTall: 0.62,      // fully applied at aspect >= tallTo
    tallFrom: 1.60,             // height/width where the lift starts
    tallTo: 2.20,               // ...and where it is fully applied

    baseSpeed: 430,         // starting scroll speed, design px per second
    acceleration: 6.5,      // speed gained per second of survival
    maxSpeed: 950,          // hard cap so it stays humanly playable (~80s in)

    scorePerPixel: 0.024,   // distance -> score conversion
    milestone: 500,         // score step that triggers the HUD pop
  },

  player: {
    // Visual box (design px). Matches the sprite's 53x30 frame (1.77) — a
    // running cat is much longer than it is tall. Width is the gameplay-
    // critical axis (see the jump-distance rule in `world`), so it stays put
    // and the height follows the artwork.
    width: 72,
    height: 41,
    xRatio: 0.16,           // horizontal position, fraction of canvas width...
    minX: 34,               // ...clamped between these two (design px)
    maxX: 190,

    // --- Jump physics (see Player.update for the full explanation) ---
    gravity: 2800,          // downward acceleration, design px / s²
    jumpStrength: 1030,     // instant upward velocity on press, design px / s
    holdForce: 1450,        // extra lift while the button stays held
    maxHoldTime: 0.17,      // for how long (s) holding still lifts
    jumpCutMultiplier: 0.45,// releasing early chops the remaining rise
    maxFallSpeed: 2400,     // terminal velocity (prevents tunneling)
    coyoteTime: 0.09,       // grace period to jump right after leaving ground
    jumpBuffer: 0.13,       // a press this long before landing still registers
    squashAmount: 0.22,     // landing squash-and-stretch; set 0 to disable
                            // (non-uniform scaling can look wrong on pixel art)

    // --- Hitbox insets (design px, shaved off each side of the visual box) ---
    // Smaller hitbox than sprite = forgiving, "feels fair" collisions.
    // Measured off the run sprite's column/row coverage: the tail (left ~10 art
    // px) and the whiskers (right ~5) are thin decoration, so they don't kill.
    hitbox: { top: 4, right: 4, bottom: 2, left: 7 },

    /* --- Look ---------------------------------------------------------------
     * Leave every `src` null to keep the procedural red & white kitten.
     * Point `src` at a PNG and the renderer switches to ctx.drawImage().
     *
     *   src           run cycle. A single image, OR a horizontal strip of
     *                 `frames` equally-wide frames (frame 0 leftmost).
     *   frames / fps  strip layout and playback speed. The procedural legs
     *                 swing at ~2.55 cycles/s, so fps 10 over 4 frames matches.
     *   airborneFrame which run frame to hold while jumping, if there is no
     *                 dedicated jumpSrc.
     *   jumpSrc       optional airborne pose (own strip via jumpFrames).
     *   hitSrc        optional game-over pose.
     * --------------------------------------------------------------------- */
    render: {
      // 212x30 strip: 4 frames of 53x30 — contact, gathered, passing,
      // suspension. 4 frames at 10fps = 2.5 stride cycles/sec.
      src: 'assets/kitten.png',
      frames: 4,
      fps: 10,
      airborneFrame: 0,                // unused while jumpSrc is set
      jumpSrc: 'assets/kitten-jump.png',
      jumpFrames: 1,
      hitSrc: null,
      emoji: null,
      pixelArt: null,       // null = inherit the global GameConfig.pixelArt
    },
    // Only used by the procedural fallback (if the PNGs fail to load).
    // Tinted to match the sprite so the two don't clash.
    colors: {
      fur:    '#f4e8e0',
      patch:  '#cb7a31',
      dark:   '#180c2a',
      inner:  '#edcbbd',
    },
  },

  obstacles: {
    gapMin: 330,            // horizontal gap between spawns (design px)
    gapMax: 720,
    gapSpeedBias: 0.45,     // how much the gap grows with speed (0 = not at all)
    /* Each variant: visual size + how forgiving its hitbox is + how it's drawn.
     * `render` is handed straight to a Sprite, so a variant becomes pixel art
     * with one line — no code changes needed:
     *
     *     render: { src: 'assets/crate.png' }
     *     render: { src: 'assets/torch.png', frames: 4, fps: 8 }   // animated
     *
     * Keep width/height in the same ratio as the artwork or it will be
     * stretched; the console warns once per file if they disagree. `inset`
     * shrinks the hitbox so near-misses feel fair — one number for all sides,
     * or {top,right,bottom,left} when the art isn't a plain rectangle.
     * `shadowWidth` is the contact pool's radius as a fraction of the box.
     *
     * The book sprites were trimmed of their isometric bases so both bottom
     * corners meet the floor, which changed their aspect — hence the boxes
     * being wider and shorter than the raw art would suggest. */
    variants: [
      // 17x24 sprite, flat-based
      { key: 'book',   width: 40, height: 56, weight: 4, inset: 4,
        shadowWidth: 0.44,
        render: { src: 'assets/book.png', color: '#4a86c8' } },
      // Two of the same book. Tight spacing on purpose — at this size a wide
      // pair is the hardest thing in the game, so it stays rare and narrow.
      { key: 'books',  width: 40, height: 56, weight: 1, inset: 4, count: 2, spacing: 6,
        shadowWidth: 0.44,
        render: { src: 'assets/book.png', color: '#4a86c8' } },
      // 35x26 sprite, flat-based
      { key: 'stack',  width: 64, height: 48, weight: 3, inset: 6,
        shadowWidth: 0.50,
        render: { src: 'assets/book-stack.png', color: '#b03a2e' } },
      // 22x32 sprite, and the biggest thing on the table. Thin wick over a wide
      // dish, so the sides give way far more than the top does.
      { key: 'candle', width: 56, height: 81, weight: 3,
        inset: { top: 4, right: 13, left: 13 },
        shadowWidth: 0.58,
        render: { src: 'assets/candle.png', color: '#e8e0c8' } },
    ],
  },

  collectibles: {
    // Matches the pastelito sprite's 56x47 frame (aspect 1.19). A square box
    // would squash the artwork horizontally.
    width: 48,              // design px
    height: 40,
    points: 50,
    hitboxInset: -6,        // NEGATIVE = grow the hitbox -> easier to grab
    gapMin: 520,            // horizontal gap between cupcake groups
    gapMax: 1350,
    groupChance: 0.45,      // odds of spawning an arc of several cupcakes
    groupSize: [2, 4],
    groupSpacing: 78,
    lowHeight: 70,          // hover height above the ground (design px)
    highHeight: 165,        // "must jump" height (stays under the jump apex)

    /* --- Fair placement ----------------------------------------------------
     * Both derived from the real jump arc rather than guessed:
     *
     * reachSafety  Fraction of maximum reach a pastelito may sit at. The
     *              ceiling is apex + player height; grazing it would need a
     *              frame-perfect jump, so heights stay a margin inside.
     * comboSpread  How much of one jump a group may span, so its last
     *              pastelito can't drag the landing somewhere unplanned.
     * landingFrom/To
     *              The stretch, in jump lengths ahead of a pastelito, where the
     *              cat comes back down. A group slides forward until no
     *              obstacle sits in any of those windows — so going for a
     *              pastelito can never drop you onto something. */
    reachSafety: 0.78,
    comboSpread: 0.45,
    landingFrom: 0.20,
    landingTo: 1.05,
    highChance: 0.55,
    bobAmplitude: 7,        // idle float animation
    bobSpeed: 3.2,
    // Warm gold glow rather than pink: on the dark magenta world it separates
    // the golden pastries from the background instead of blending into it.
    render: { src: 'assets/pastelito.png', emoji: null, color: '#ffc46b' },
  },

  fx: {
    particles: true,
    maxParticles: 140,
    cloudCount: 5,
    cloudSpeedRatio: 0.14,  // parallax: clouds move at 14% of world speed
    hillSpeedRatio: 0.32,
    shakeOnHit: 14,         // screen-shake amplitude in design px
  },

  /* Canvas palette. Picked automatically from prefers-color-scheme so the
     painted world matches the CSS chrome around it. Edit freely — or force one
     with: GameConfig.theme.force = 'light'. */
  theme: {
    // Pinned to 'dark' so the magenta night is what everyone sees, whatever
    // their phone's theme is set to. Set this back to null to follow the
    // device again (the light palette below is the daytime version).
    force: 'dark',

    /* ---- Optional pixel-art map ---------------------------------------------
     * Leave `src` null and the painted gradient / solid floor below are used
     * instead — the same fallback rule the entity sprites follow. Point it at a
     * PNG and the painting is skipped entirely:
     *
     *     GameConfig.theme.skyImage.src    = 'assets/sky.png';
     *     GameConfig.theme.groundImage.src = 'assets/floor.png';
     *
     *   mode 'tile'     repeats the image horizontally and scrolls it, keeping
     *                   the art's own aspect. Use for floor strips and
     *                   repeating skylines. The image must wrap left-to-right
     *                   seamlessly or you'll see the seam fly past.
     *   mode 'stretch'  draws one copy filling the whole band. Use for a single
     *                   painted sky.
     *   speedRatio      0 = pinned in place, 1 = scrolls with the world.
     *                   Lower reads as further away.
     *   height          (ground only) strip height in design px. null fills all
     *                   the way down to the bottom of the screen.
     *   offsetY         (ground only) how far the art's TOP sits ABOVE the
     *                   ground line, in design px. The walking surface in the
     *                   art is rarely its top edge — the café table has chair
     *                   backs standing proud of it — so this lifts the strip
     *                   until the surface itself lands on the ground line and
     *                   the cat's feet meet the table.
     *
     * Shared by both palettes. Move them inside `light`/`dark` below if you
     * ever want separate day and night art. */
    skyImage: {
      // 48x60 café window wall. Cropped to a seamless slice of the original,
      // so it repeats without a visible join as it drifts past.
      src: 'assets/sky.png', mode: 'tile', speedRatio: 0.12, pixelArt: null,
    },
    groundImage: {
      // No floor art in use — the painted ground line and speed dashes are
      // drawn instead. Point `src` at a tileable strip to switch back;
      // `offsetY` then lifts it so the art's walking surface, not its top
      // edge, lands on the ground line.
      src: null, mode: 'tile', speedRatio: 1,
      height: 46, offsetY: 9.5, pixelArt: null,
    },

    light: {
      skyTop: '#ffd9f0', skyBottom: '#ff9ed4',
      hills: 'rgba(255,255,255,.40)',
      cloud: '#fff0f8',
      ground: '#f7d8ec', groundLine: '#c9569f', groundDash: 'rgba(201,86,159,.70)',
      dust: 'rgba(150,90,130,.70)',
      shadow: 'rgba(0,0,0,1)', shadowAlpha: 0.18,
    },

    /* The active palette (theme.force pins it here). Retuned from the magenta
       night to the café, with values sampled straight out of the map art:
       mint #abf0d4 and cream #f6efd2 from the window wall, table cream #ccb595
       and chair wood #61302a from the floor.

       Most of these only show through as fallbacks now — the sky and floor art
       cover the gradient, hills, ground line and dashes. The ones that still
       matter every frame are `ground` (visible below the table, between the
       chair legs), `dust`, and the contact shadows. */
    dark: {
      skyTop: '#dcd8c8', skyBottom: '#abf0d4',
      hills: 'rgba(255,255,255,.25)',
      cloud: 'rgba(255,255,255,.35)',
      ground: '#33201c', groundLine: '#61302a', groundDash: 'rgba(204,181,149,.60)',
      dust: 'rgba(204,181,149,.75)',
      shadow: 'rgba(0,0,0,1)', shadowAlpha: 0.30,
    },
  },

  loop: {
    maxDelta: 0.05,         // clamp dt (s) so an alt-tab can't teleport entities
    maxDPR: 2,              // cap devicePixelRatio (perf on high-density phones)
  },

  input: {
    restartDelay: 0.45,     // s after dying before a tap restarts (anti-misclick)
  },

  /* ---- Sound ---------------------------------------------------------------
   * Every clip is optional: a null `src`, a missing file or a browser that
   * refuses to play simply means silence, never a broken game.
   *
   *   volume      0..1, multiplied by `master` (and by `music` for the track)
   *   pool        how many copies to keep. A sound that can retrigger before it
   *               finishes needs > 1, because one HTMLAudioElement can only
   *               play once at a time — a second pickup would cut the first off
   *               mid-sound. Pickups and jumps overlap; a death cannot.
   *   startAt     seconds to skip at the head of the file. These recordings
   *               carry leading silence, and since playback starts at 0 that
   *               silence lands as input lag — measured: jump 118ms, meow
   *               147ms, and cat-hit a full 744ms. Each value below sits just
   *               before the real onset, so the attack isn't clipped.
   *   maxSeconds  how long to play for, counted from `startAt`. cat-hit is a 5s
   *               file whose audio is all inside 725-900ms; without this it
   *               would hold silence straight over the next run.
   */
  audio: {
    enabled: true,
    master: 0.9,
    musicVolume: 0.30,
    sfxKey: 'kittyRunner.mutedSfx',
    musicKey: 'kittyRunner.mutedMusic',

    sfx: {
      jump:   { src: 'assets/sounds/cat/cat-jump.mp3',  volume: 0.40, pool: 3,
                startAt: 0.10 },
      pickup: { src: 'assets/sounds/items/pastelito/pastelito-take.wav',
                volume: 0.55, pool: 4 },          // no lead silence; starts at 0
      hit:    { src: 'assets/sounds/cat/cat-hit.mp3',   volume: 0.85, pool: 2,
                startAt: 0.71, maxSeconds: 0.30 },
      meow:   { src: 'assets/sounds/cat/cat-sound.mp3', volume: 0.70, pool: 2,
                startAt: 0.13 },
    },

    // 3.7MB / 226s. Loaded lazily on the first user gesture so it never delays
    // the game appearing.
    music: { src: 'assets/sounds/soundtrack/menu-song.mp3', loop: true },
  },

  /* ---- Pre-premiere lock ---------------------------------------------------
   * While enabled and the release date is still ahead, the whole page goes
   * black, every input is swallowed and only the countdown shows. It unlocks
   * by itself the moment the date passes — no reload needed.
   *
   * `releaseDate` is read as LOCAL time, so '2026-08-01T00:00:00' means
   * midnight where the player is. Edit that string and nothing else.
   *
   * NOTE: a presentation gate, not a security one. Everything runs in the
   * browser, so anyone who opens devtools can walk straight past it. If the
   * game genuinely must not be playable before launch, don't ship the files
   * until then. */
  prePremiere: {
    enabled: false,
    releaseDate: '2026-08-01T00:00:00',
    eyebrow: 'PROXIMAMENTE',
    title: '😴😴😴😴',
    dateNote: '→←',
    bypassParam: 'preview',   // ?preview=1 skips the lock while you're testing
  },

  /* Global default for every Sprite that doesn't override it.
   * true  -> nearest-neighbour scaling + whole-pixel snapping. Chunky and crisp:
   *          what you want for hand-made pixel art, which the browser would
   *          otherwise blur when it scales a 33x28 PNG up to 112px.
   * false -> normal smoothing, for hi-res / painted artwork. */
  pixelArt: true,

  storageKey: 'kittyRunner.best',
};


/* =============================================================================
 * 2. UTILS
 * ========================================================================== */
const Utils = {
  clamp: (v, min, max) => (v < min ? min : v > max ? max : v),
  rand: (min, max) => min + Math.random() * (max - min),
  randInt: (min, max) => Math.floor(Utils.rand(min, max + 1)),

  /** Weighted pick from `[{ weight }]`. Missing weights count as 1. */
  weightedPick(list) {
    const total = list.reduce((sum, item) => sum + (item.weight || 1), 0);
    let roll = Math.random() * total;
    for (const item of list) {
      roll -= (item.weight || 1);
      if (roll <= 0) return item;
    }
    return list[list.length - 1];
  },

  /* ---------------------------------------------------------------------------
   * RECTANGULAR (AABB) COLLISION — the whole detection system, in 4 comparisons.
   *
   * AABB = "Axis-Aligned Bounding Box": a rectangle that is never rotated, so
   * it can be described by { x, y, w, h } alone. Two AABBs overlap only if they
   * overlap on BOTH axes at the same time. Written as "cannot NOT overlap":
   *
   *        a.x ───────── a.x + a.w
   *   ┌──────────┐
   *   │     A    │        They MISS if any of these is true:
   *   └──────────┘          A is entirely left  of B : a.x + a.w <= b.x
   *          ┌──────────┐   A is entirely right of B : a.x       >= b.x + b.w
   *          │     B    │   A is entirely above  B   : a.y + a.h <= b.y
   *          └──────────┘   A is entirely below  B   : a.y       >= b.y + b.h
   *
   * Negate all four and you get the test below. It is O(1) per pair, which is
   * why we can brute-force every entity every frame without profiling anything.
   *
   * To upgrade later: swap this for circle-vs-rect (cheap, great for the
   * cupcakes) or add a swept/continuous test if you ever raise maxSpeed enough
   * that an entity can jump *through* another between two frames.
   * ------------------------------------------------------------------------ */
  intersects(a, b) {
    return a.x < b.x + b.w &&
           a.x + a.w > b.x &&
           a.y < b.y + b.h &&
           a.y + a.h > b.y;
  },
};


/* Local storage, but it can't take the game down. Safari private mode and
 * sandboxed iframes throw on the very first access, and the high score is not
 * worth losing a run over. */
const Storage = {
  get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* no-op */ } },
};


/* =============================================================================
 * SOUND
 *
 * Deliberately built on plain <audio> rather than the Web Audio API: the game
 * needs a handful of one-shots and one looping track, and HTMLAudioElement does
 * that with no context plumbing and no decode step.
 *
 * Three facts drive the whole design:
 *
 *  1. BROWSERS BLOCK AUDIO until the user interacts with the page. So nothing
 *     plays until `unlock()` is called from a real input event — and the music,
 *     which is 3.7MB, isn't even fetched until then.
 *  2. ONE ELEMENT PLAYS ONE SOUND. Retriggering restarts it, cutting the
 *     previous one off. Sounds that can overlap (pickups, jumps) therefore keep
 *     a small pool of copies and round-robin through it.
 *  3. AUDIO FAILS IN PUBLIC. A missing file, an unsupported codec, a refused
 *     play() — every one of them is caught and ignored. Silence is an
 *     acceptable outcome; an exception in the middle of a jump is not.
 * ========================================================================== */
class AudioManager {
  constructor(cfg) {
    this.cfg = cfg;
    this.unlocked = false;
    this.pools = new Map();       // name -> { els, next, def }
    this.music = null;
    this.musicWanted = false;

    // Two independent switches: plenty of people want the effects but not the
    // music, and each is remembered separately.
    this.mutedSfx = Storage.get(cfg.sfxKey) === '1';
    this.mutedMusic = Storage.get(cfg.musicKey) === '1';
  }

  /** Build the one-shot pools. Cheap: metadata only, no audio data yet. */
  load() {
    if (!this.cfg.enabled) return;
    for (const [name, def] of Object.entries(this.cfg.sfx)) {
      if (!def.src) continue;
      const els = [];
      for (let i = 0; i < (def.pool || 1); i++) {
        const el = new Audio();
        el.preload = 'auto';
        el.src = def.src;
        el.volume = Utils.clamp((def.volume ?? 1) * this.cfg.master, 0, 1);
        els.push(el);
      }
      this.pools.set(name, { els, next: 0, def });
    }
  }

  /**
   * Called from the first real user gesture. Kicks each element once to satisfy
   * the autoplay policy, then starts the music if it was requested earlier.
   */
  unlock() {
    if (this.unlocked || !this.cfg.enabled) return;
    this.unlocked = true;

    for (const { els } of this.pools.values()) {
      const el = els[0];
      const p = el.play();
      if (p && p.then) {
        p.then(() => { el.pause(); el.currentTime = 0; }).catch(() => {});
      }
    }
    if (this.musicWanted) this.startMusic();
  }

  /** Fire a one-shot. Safe to call before unlock (it just does nothing). */
  play(name) {
    if (!this.cfg.enabled || this.mutedSfx || !this.unlocked) return;
    const pool = this.pools.get(name);
    if (!pool) return;

    const el = pool.els[pool.next];
    pool.next = (pool.next + 1) % pool.els.length;

    // Seek past any baked-in leading silence, so the sound lands on the frame
    // that triggered it instead of a fraction of a second later.
    const from = pool.def.startAt || 0;
    try {
      el.currentTime = from;
      const p = el.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* nothing worth breaking a frame over */ }

    // Stop after `maxSeconds` of actual audio, measured from `startAt`.
    if (pool.def.maxSeconds) {
      clearTimeout(el._cut);
      el._cut = setTimeout(() => {
        try { el.pause(); el.currentTime = from; } catch (e) { /* no-op */ }
      }, pool.def.maxSeconds * 1000);
    }
  }

  /** Cut a sound short — used so a death sound can't bleed into the next run. */
  stop(name) {
    const pool = this.pools.get(name);
    if (!pool) return;
    for (const el of pool.els) {
      clearTimeout(el._cut);
      try { el.pause(); el.currentTime = pool.def.startAt || 0; }
      catch (e) { /* no-op */ }
    }
  }

  startMusic() {
    const m = this.cfg.music;
    if (!this.cfg.enabled || !m || !m.src) return;
    this.musicWanted = true;
    if (!this.unlocked || this.mutedMusic) return;   // resumes from unlock()

    if (!this.music) {                       // lazy: 3.7MB, fetched on demand
      this.music = new Audio();
      this.music.src = m.src;
      this.music.loop = m.loop !== false;
      this.music.preload = 'auto';
    }
    this.music.volume = Utils.clamp(this.cfg.musicVolume * this.cfg.master, 0, 1);
    const p = this.music.play();
    if (p && p.catch) p.catch(() => {});
  }

  pauseMusic() {
    if (this.music) { try { this.music.pause(); } catch (e) { /* no-op */ } }
  }

  resumeMusic() {
    if (this.musicWanted && !this.mutedMusic) this.startMusic();
  }

  /** Effects only. @returns {boolean} the new muted state. */
  toggleSfx() {
    this.mutedSfx = !this.mutedSfx;
    Storage.set(this.cfg.sfxKey, this.mutedSfx ? '1' : '0');
    if (this.mutedSfx) for (const name of this.pools.keys()) this.stop(name);
    return this.mutedSfx;
  }

  /** Background track only. @returns {boolean} the new muted state. */
  toggleMusic() {
    this.mutedMusic = !this.mutedMusic;
    Storage.set(this.cfg.musicKey, this.mutedMusic ? '1' : '0');
    if (this.mutedMusic) this.pauseMusic();
    else this.resumeMusic();
    return this.mutedMusic;
  }
}


/* =============================================================================
 * 3. SPRITE — the single seam between "game logic" and "how it looks".
 *
 * Every entity owns a Sprite and only ever calls `sprite.draw(ctx, x, y, w, h)`.
 * The Sprite decides, in order of priority:
 *    1. `src` set and the image is loaded  -> ctx.drawImage()   <-- your art
 *    2. `emoji` set                        -> ctx.fillText()    <-- placeholder
 *    3. otherwise                          -> ctx.fillRect()    <-- placeholder
 *
 * SWAPPING IN YOUR OWN SPRITES:
 *   GameConfig.player.render.src = 'assets/kitten.png';
 *   GameConfig.collectibles.render.src = 'assets/cupcake.png';
 * ...and nothing else changes.
 *
 * SPRITESHEETS: pass `frames: 4` and lay the frames out in ONE horizontal row
 * of equal width (frame 0 leftmost). draw() then uses the 9-argument drawImage
 * overload to blit a single cell — call sites just pass a frame index.
 *
 * PIXEL ART: `pixelArt` (or the global GameConfig.pixelArt) turns off canvas
 * smoothing and snaps the destination rect to whole pixels. Both matter: the
 * browser blurs an upscaled 33x28 PNG by default, and sub-pixel destinations
 * make the pixel grid shimmer as the sprite moves.
 * ========================================================================== */
class Sprite {
  constructor({ src = null, emoji = null, color = '#333', radius = 6,
                frames = 1, fps = 10, pixelArt = null } = {}) {
    this.emoji = emoji;
    this.color = color;
    this.radius = radius;      // corner rounding for the fillRect fallback
    this.frames = Math.max(1, frames);
    this.fps = fps;
    this.pixelArt = pixelArt;  // null -> inherit the global setting
    this.image = null;

    if (src) {
      /* Share one Image per file across every Sprite that uses it. Entities are
       * constructed constantly — a new cupcake every few hundred ms — and each
       * one minting its own Image means it starts with isImageReady false and
       * paints the placeholder rectangle for its first frame(s). Cached, only
       * the very first one ever waits. */
      let img = Sprite.images.get(src);
      if (!img) {
        img = new Image();
        img.src = src;
        Sprite.images.set(src, img);
      }
      this.image = img;
    }
  }

  get isImageReady() {
    return !!this.image && this.image.complete && this.image.naturalWidth > 0;
  }

  get usesPixelArt() {
    return this.pixelArt === null ? !!GameConfig.pixelArt : !!this.pixelArt;
  }

  /** Width of one frame in the source image, in source pixels. */
  get frameWidth() {
    return this.isImageReady ? this.image.naturalWidth / this.frames : 0;
  }

  /**
   * Paint into the box (x, y, w, h). Top-left anchored, like every entity.
   * @param {number} frame index into a horizontal spritesheet; wraps safely.
   */
  draw(ctx, x, y, w, h, frame = 0) {
    // 1) Real artwork — the future path.
    if (this.isImageReady) {
      ctx.save();
      if (this.usesPixelArt) {
        // Whole-pixel destination: sub-pixel positions make a pixel grid crawl.
        x = Math.round(x); y = Math.round(y);
        w = Math.round(w); h = Math.round(h);

        /* Nearest-neighbour is what keeps pixel art crisp — but only when
         * scaling UP. Squeezing a 106px-wide sprite into 70 device pixels with
         * smoothing off drops whole columns and shimmers as the sprite moves,
         * so hand a downscale back to the browser's filter instead. */
        const zoom = ctx.getTransform ? ctx.getTransform().a : 1;
        ctx.imageSmoothingEnabled = w * zoom < this.frameWidth;
      }

      if (this.frames > 1) {
        const cell = this.image.naturalWidth / this.frames;
        const index = ((frame % this.frames) + this.frames) % this.frames;  // never negative
        ctx.drawImage(this.image, index * cell, 0, cell, this.image.naturalHeight,
                      x, y, w, h);
      } else {
        ctx.drawImage(this.image, x, y, w, h);
      }

      ctx.restore();   // save/restore also puts imageSmoothingEnabled back
      this.checkAspect(w, h);
      return;
    }

    // 2) Emoji placeholder. `h` as font size keeps it proportional on resize.
    if (this.emoji) {
      ctx.save();
      ctx.font = `${h}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.emoji, x + w / 2, y + h / 2);
      ctx.restore();
      return;
    }

    // 3) Solid rounded rectangle placeholder.
    ctx.save();
    ctx.fillStyle = this.color;
    ctx.beginPath();
    const r = Math.min(this.radius, w / 2, h / 2);
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y,     x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x,     y + h, r);
    ctx.arcTo(x,     y + h, x,     y,     r);
    ctx.arcTo(x,     y,     x + w, y,     r);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /**
   * Repeat the image horizontally across (x .. x+w), scrolled left by `offset`
   * pixels. This is what lets a pixel-art sky or floor strip wrap seamlessly as
   * the world scrolls — a single drawImage would just stretch one copy across
   * the screen.
   *
   * The tile's width is derived from the target height, so the art always keeps
   * its own aspect ratio no matter how tall the band is. For the seam to be
   * invisible the source image has to be horizontally tileable (its right edge
   * must continue into its left edge).
   *
   * @returns {boolean} false when there's no image yet, so the caller can fall
   *                    back to painting the band by hand.
   */
  drawTiled(ctx, x, y, w, h, offset = 0) {
    if (!this.isImageReady) return false;

    const tileW = Math.max(1, Math.round(this.frameWidth * (h / this.image.naturalHeight)));

    ctx.save();
    if (this.usesPixelArt) {
      ctx.imageSmoothingEnabled = false;
      x = Math.round(x); y = Math.round(y); h = Math.round(h);
    }
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();                       // never spill outside the band

    // Wrap the scroll offset into [0, tileW) and start one tile early, so the
    // left edge is always covered however far the world has travelled.
    const shift = ((offset % tileW) + tileW) % tileW;
    for (let px = x - shift; px < x + w; px += tileW) {
      ctx.drawImage(this.image, 0, 0, this.frameWidth, this.image.naturalHeight,
                    Math.round(px), y, tileW, h);
    }
    ctx.restore();
    return true;
  }

  /**
   * One-time console nudge when art is being drawn at a different aspect than
   * it was authored at. Without it a wrong width/height in the config just
   * quietly squashes the sprite, which is easy to stare past.
   */
  checkAspect(w, h) {
    if (!this.isImageReady || Sprite.warned.has(this.image.src)) return;
    Sprite.warned.add(this.image.src);

    const art = this.frameWidth / this.image.naturalHeight;
    const box = w / h;
    if (Math.abs(art - box) / art > 0.12) {
      const name = this.image.src.startsWith('data:')
        ? '(inline image)'
        : this.image.src.split('/').pop();
      console.warn(`[Sprite] ${name} is ${art.toFixed(2)}:1 but is being drawn at ` +
        `${box.toFixed(2)}:1 — it will look stretched. Match the width/height ` +
        `in GameConfig to the artwork.`);
    }
  }
}

/** src -> shared HTMLImageElement. One decode per file, for the whole session. */
Sprite.images = new Map();

/** srcs already reported by checkAspect, so the warning fires once, not 60x/s. */
Sprite.warned = new Set();


/* =============================================================================
 * 4. ENTITY — shared base for everything that lives in the world.
 *
 * Coordinates are top-left anchored and already in *screen* pixels: the Game
 * multiplies the design-px config values by `scale` when it spawns things, so
 * update/draw code never has to think about DPI or screen size again.
 * ========================================================================== */
class Entity {
  constructor(game, { x = 0, y = 0, width = 0, height = 0, sprite = null } = {}) {
    this.game = game;
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.sprite = sprite || new Sprite({});
    this.dead = false;                                  // flagged -> culled
    this.hitbox = { top: 0, right: 0, bottom: 0, left: 0 }; // screen-px insets
  }

  /* -------------------------------------------------------------------------
   * The *visual* box and the *collision* box are deliberately different.
   * `hitbox` holds an inset per side: positive shrinks the box (forgiving,
   * used by the kitten and the crates), negative grows it (generous, used by
   * the cupcakes so near-misses still count as a pickup).
   *
   *   visual box                hitbox (top:12, left:12, right:14, bottom:4)
   *   ┌─────────────┐           ┌─────────────┐
   *   │             │           │  ┌───────┐  │   <- what actually collides
   *   │     🐈      │    ==>    │  │       │  │
   *   │             │           │  └───────┘  │
   *   └─────────────┘           └─────────────┘
   *
   * Debug tip: set `game.debug = true` (from the console) to draw both boxes.
   * ---------------------------------------------------------------------- */
  getHitbox() {
    const h = this.hitbox;
    return {
      x: this.x + h.left,
      y: this.y + h.top,
      w: this.width  - h.left - h.right,
      h: this.height - h.top  - h.bottom,
    };
  }

  /** Scrolls left with the world. dt in seconds, speed in screen px/s. */
  update(dt, speed) {
    this.x -= speed * dt;
    if (this.x + this.width < -50) this.dead = true;   // culled off-screen
  }

  draw(ctx) {
    this.sprite.draw(ctx, this.x, this.y, this.width, this.height);
  }

  /**
   * Called on window resize (see Game.resize).
   * @param {number} sizeRatio   how much the size scale changed
   * @param {number} widthRatio  how much the canvas width changed (keeps the
   *                             entity at the same relative horizontal spot)
   * @param {number} groundDelta vertical correction for the new ground line
   */
  rescale(sizeRatio, widthRatio, groundDelta) {
    this.x *= widthRatio;
    this.width *= sizeRatio;
    this.height *= sizeRatio;
    this.y = this.y * sizeRatio + groundDelta;
    for (const key of Object.keys(this.hitbox)) this.hitbox[key] *= sizeRatio;
  }
}


/* =============================================================================
 * 5. PLAYER — the red & white kitten.
 * ========================================================================== */
class Player extends Entity {
  constructor(game) {
    const cfg = GameConfig.player;
    super(game, {
      width: cfg.width * game.scale,
      height: cfg.height * game.scale,
      sprite: new Sprite(cfg.render),
    });

    /* One Sprite per animation state. `run` is always present (it doubles as
     * the fallback); the other two are only built if you configured art for
     * them, and `activeSprite` degrades gracefully when they're missing. */
    this.sprites = {
      run: this.sprite,
      jump: cfg.render.jumpSrc
        ? new Sprite(Object.assign({}, cfg.render,
            { src: cfg.render.jumpSrc, frames: cfg.render.jumpFrames }))
        : null,
      hit: cfg.render.hitSrc
        ? new Sprite(Object.assign({}, cfg.render,
            { src: cfg.render.hitSrc, frames: 1 }))
        : null,
    };

    this.velocityY = 0;
    this.onGround = true;
    this.coyoteTimer = 0;    // time left during which a late jump still works
    this.bufferTimer = 0;    // time left on an early (pre-landing) jump press
    this.holdTimer = 0;      // how long the current jump has been held
    this.isHolding = false;
    this.runTime = 0;        // animation clock
    this.squash = 0;         // 0..1, landing squash-and-stretch amount

    this.syncToScreen();
  }

  /** Places the kitten at its configured X and drops it on the ground line. */
  syncToScreen() {
    const cfg = GameConfig.player;
    const s = this.game.scale;

    this.width = cfg.width * s;
    this.height = cfg.height * s;
    this.hitbox = {
      top:    cfg.hitbox.top * s,
      right:  cfg.hitbox.right * s,
      bottom: cfg.hitbox.bottom * s,
      left:   cfg.hitbox.left * s,
    };

    this.x = Utils.clamp(
      this.game.width * cfg.xRatio,
      cfg.minX * s,
      cfg.maxX * s
    );
    this.y = this.game.groundY - this.height;
    this.velocityY = 0;
    this.onGround = true;
  }

  /* -------------------------------------------------------------------------
   * JUMP PHYSICS — a semi-implicit (symplectic) Euler integrator.
   *
   * Two lines do all the work, every frame:
   *      velocityY += gravity * dt;      // 1. accelerate
   *      y         += velocityY * dt;    // 2. then move with the NEW velocity
   *
   * Order matters: updating velocity *before* position is what makes this
   * "semi-implicit" Euler, which stays stable at variable frame rates. Because
   * both lines are multiplied by dt (seconds elapsed), a 60Hz laptop and a
   * 120Hz phone travel the exact same arc — the physics is frame-rate
   * independent. dt is clamped in Game.loop() so a background tab can't produce
   * one huge step that teleports the kitten through the floor.
   *
   * Arc math, if you want to tune by *height* instead of by velocity:
   *      apexHeight = jumpStrength² / (2 * gravity)
   *      airTime    = 2 * jumpStrength / gravity
   * With the defaults: 1030² / (2*2800) ≈ 189 design px up, ≈ 0.74 s airborne.
   * So: to jump exactly H px high -> jumpStrength = Math.sqrt(2 * gravity * H).
   *
   * Three "game feel" tricks layered on top (all optional, all in Config):
   *   - COYOTE TIME  : you may still jump for ~90ms after walking off a ledge.
   *   - JUMP BUFFER  : a press up to ~130ms before landing is remembered and
   *                    fires the instant you touch down.
   *   - VARIABLE JUMP: holding adds `holdForce` for up to `maxHoldTime`, and
   *                    releasing while still rising cuts the upward velocity by
   *                    `jumpCutMultiplier` -> tap = hop, hold = full jump.
   * ---------------------------------------------------------------------- */
  update(dt) {
    const cfg = GameConfig.player;
    const s = this.game.scale;

    this.runTime += dt;

    // --- Timers -----------------------------------------------------------
    this.coyoteTimer = this.onGround ? cfg.coyoteTime : Math.max(0, this.coyoteTimer - dt);
    this.bufferTimer = Math.max(0, this.bufferTimer - dt);

    // --- Consume a buffered jump as soon as it becomes legal ---------------
    if (this.bufferTimer > 0 && this.coyoteTimer > 0) {
      this.performJump();
    }

    // --- Variable jump height ---------------------------------------------
    if (!this.onGround && this.isHolding && this.holdTimer < cfg.maxHoldTime && this.velocityY < 0) {
      this.velocityY -= cfg.holdForce * s * dt;   // extra lift while held
      this.holdTimer += dt;
    }

    // --- Integrate (the two lines described above) -------------------------
    this.velocityY += cfg.gravity * s * dt;
    this.velocityY = Math.min(this.velocityY, cfg.maxFallSpeed * s);
    this.y += this.velocityY * dt;

    // --- Ground resolution -------------------------------------------------
    const floor = this.game.groundY - this.height;
    if (this.y >= floor) {
      if (!this.onGround) this.land();
      this.y = floor;
      this.velocityY = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }

    // Squash decays back to 0 after landing (purely cosmetic).
    this.squash = Math.max(0, this.squash - dt * 4.5);
  }

  /** Called by the input layer. Buffers the press; update() decides if it fires. */
  requestJump() {
    this.isHolding = true;
    if (this.coyoteTimer > 0) this.performJump();
    else this.bufferTimer = GameConfig.player.jumpBuffer;
  }

  releaseJump() {
    this.isHolding = false;
    // Jump cut: let go mid-rise and the kitten stops climbing early.
    if (this.velocityY < 0) this.velocityY *= GameConfig.player.jumpCutMultiplier;
  }

  performJump() {
    this.velocityY = -GameConfig.player.jumpStrength * this.game.scale;
    this.onGround = false;
    this.coyoteTimer = 0;
    this.bufferTimer = 0;
    this.holdTimer = 0;
    this.game.spawnDust(this.x + this.width * 0.3, this.game.groundY, 5);
    this.game.audio.play('jump');
  }

  land() {
    this.squash = Math.min(1, Math.abs(this.velocityY) / (1400 * this.game.scale));
    this.game.spawnDust(this.x + this.width * 0.4, this.game.groundY, 7);
  }

  /** Which artwork the current state calls for (falls back to the run sheet). */
  get activeSprite() {
    if (this.game.state === 'over' && this.sprites.hit) return this.sprites.hit;
    if (!this.onGround && this.sprites.jump) return this.sprites.jump;
    return this.sprites.run;
  }

  /**
   * Frame index for the active sheet. The run cycle is driven by `runTime`
   * rather than by a per-frame counter, so it plays at a constant speed no
   * matter the refresh rate. Sprite.draw() wraps the index, so it can grow
   * forever without an explicit modulo here.
   */
  get animationFrame() {
    const sprite = this.activeSprite;
    if (sprite.frames <= 1) return 0;
    // Airborne on the run sheet: hold one pose instead of running in mid-air.
    if (!this.onGround && sprite === this.sprites.run) {
      return GameConfig.player.render.airborneFrame;
    }
    return Math.floor(this.runTime * sprite.fps);
  }

  /* ------------------------------------------------------------------------
   * Drawing. If you set GameConfig.player.render.src, the Sprite takes over
   * and everything below the first `if` is skipped.
   * --------------------------------------------------------------------- */
  draw(ctx) {
    const amount = GameConfig.player.squashAmount;
    const squashY = 1 - this.squash * amount;
    const squashX = 1 + this.squash * amount * 0.82;
    const w = this.width * squashX;
    const h = this.height * squashY;
    const x = this.x - (w - this.width) / 2;
    const y = this.y + (this.height - h);          // keep the feet on the floor

    // Contact shadow — shrinks as the kitten rises.
    const airFactor = Utils.clamp(1 - (this.game.groundY - (this.y + this.height)) / (200 * this.game.scale), 0.25, 1);
    ctx.save();
    ctx.globalAlpha = this.game.palette.shadowAlpha * airFactor;
    ctx.fillStyle = this.game.palette.shadow;
    ctx.beginPath();
    ctx.ellipse(this.x + this.width / 2, this.game.groundY + 2,
                this.width * 0.42 * airFactor, this.height * 0.11 * airFactor, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const sprite = this.activeSprite;
    if (sprite.isImageReady || sprite.emoji) {
      sprite.draw(ctx, x, y, w, h, this.animationFrame);
    } else {
      this.drawKitten(ctx, x, y, w, h);   // no art configured -> procedural cat
    }

    if (this.game.debug) this.drawDebugBoxes(ctx);
  }

  /**
   * Procedural placeholder: a red & white kitten out of plain canvas shapes.
   * Delete this whole method once you plug a real sprite into config.render.src.
   */
  drawKitten(ctx, x, y, w, h) {
    const c = GameConfig.player.colors;
    // Legs cycle while grounded; tuck up while airborne.
    const cycle = Math.sin(this.runTime * 16);
    const legSwing = this.onGround ? cycle * h * 0.10 : -h * 0.06;
    const bodyBob = this.onGround ? Math.abs(cycle) * h * 0.03 : 0;

    ctx.save();
    ctx.translate(x, y - bodyBob);

    // --- Tail (a wagging quadratic curve) ---
    ctx.strokeStyle = c.patch;
    ctx.lineWidth = h * 0.11;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(w * 0.08, h * 0.58);
    ctx.quadraticCurveTo(-w * 0.16, h * (0.40 + cycle * 0.06), w * 0.02, h * 0.16);
    ctx.stroke();

    // --- Back legs / front legs ---
    ctx.fillStyle = c.fur;
    ctx.fillRect(w * 0.24, h * 0.74 + legSwing, w * 0.14, h * 0.26 - legSwing);
    ctx.fillRect(w * 0.60, h * 0.74 - legSwing, w * 0.14, h * 0.26 + legSwing);

    // --- Body (white) ---
    ctx.beginPath();
    ctx.ellipse(w * 0.44, h * 0.62, w * 0.30, h * 0.24, 0, 0, Math.PI * 2);
    ctx.fill();

    // --- Red patch on the back ---
    ctx.fillStyle = c.patch;
    ctx.beginPath();
    ctx.ellipse(w * 0.32, h * 0.53, w * 0.17, h * 0.14, -0.25, 0, Math.PI * 2);
    ctx.fill();

    // --- Head (white) ---
    ctx.fillStyle = c.fur;
    ctx.beginPath();
    ctx.arc(w * 0.74, h * 0.40, h * 0.24, 0, Math.PI * 2);
    ctx.fill();

    // --- Ears (red triangles + pink inner) ---
    const ear = (cx, cy, dir) => {
      ctx.fillStyle = c.patch;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + dir * h * 0.14, cy - h * 0.20);
      ctx.lineTo(cx + dir * h * 0.20, cy + h * 0.02);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = c.inner;
      ctx.beginPath();
      ctx.moveTo(cx + dir * h * 0.04, cy - h * 0.01);
      ctx.lineTo(cx + dir * h * 0.13, cy - h * 0.15);
      ctx.lineTo(cx + dir * h * 0.16, cy + h * 0.00);
      ctx.closePath();
      ctx.fill();
    };
    ear(w * 0.62, h * 0.26, -0.6);
    ear(w * 0.82, h * 0.24,  0.6);

    // --- Red patch over one eye ---
    ctx.fillStyle = c.patch;
    ctx.beginPath();
    ctx.ellipse(w * 0.80, h * 0.33, h * 0.11, h * 0.09, 0.3, 0, Math.PI * 2);
    ctx.fill();

    // --- Face: eye, nose, whiskers ---
    ctx.fillStyle = c.dark;
    ctx.beginPath();
    ctx.arc(w * 0.83, h * 0.36, h * 0.035, 0, Math.PI * 2);   // eye
    ctx.fill();
    ctx.fillStyle = c.inner;
    ctx.beginPath();
    ctx.arc(w * 0.93, h * 0.46, h * 0.032, 0, Math.PI * 2);   // nose
    ctx.fill();

    ctx.strokeStyle = 'rgba(43,43,51,.55)';
    ctx.lineWidth = Math.max(1, h * 0.018);
    ctx.beginPath();
    ctx.moveTo(w * 0.92, h * 0.44); ctx.lineTo(w * 1.06, h * 0.39);
    ctx.moveTo(w * 0.92, h * 0.48); ctx.lineTo(w * 1.06, h * 0.50);
    ctx.stroke();

    ctx.restore();
  }

  drawDebugBoxes(ctx) {
    const hb = this.getHitbox();
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,120,255,.55)';
    ctx.strokeRect(this.x, this.y, this.width, this.height);   // visual box
    ctx.strokeStyle = 'rgba(255,0,0,.9)';
    ctx.strokeRect(hb.x, hb.y, hb.w, hb.h);                    // collision box
    ctx.restore();
  }
}


/* =============================================================================
 * 6. WORLD ENTITIES
 * ========================================================================== */

/** A generic thing to jump over. Sits flush on the ground line. */
class Obstacle extends Entity {
  /** @param {number} offsetX extra spawn distance to the right, in screen px. */
  constructor(game, variant, offsetX = 0) {
    const s = game.scale;
    super(game, {
      x: game.width + offsetX,
      width: variant.width * s,
      height: variant.height * s,
      sprite: new Sprite(variant.render),
    });
    this.y = game.groundY - this.height;
    this.variantKey = variant.key;
    this.time = Math.random() * 10;   // desync animated variants from each other

    this.shadowWidth = variant.shadowWidth;   // fraction of the box; see draw()

    /* `inset` is either one number (same shave on top/left/right) or an object
     * with per-side values, for art that isn't a plain rectangle — the candle
     * is a thin stick over a wide dish, so it wants more off the sides than
     * off the top. */
    const ins = variant.inset || 0;
    const box = typeof ins === 'number'
      ? { top: ins, right: ins, bottom: 0, left: ins }
      : { top: ins.top || 0, right: ins.right || 0,
          bottom: ins.bottom || 0, left: ins.left || 0 };
    this.hitbox = { top: box.top * s, right: box.right * s,
                    bottom: box.bottom * s, left: box.left * s };
  }

  update(dt, speed) {
    super.update(dt, speed);
    this.time += dt;                  // drives `frames` on animated variants
  }

  draw(ctx) {
    // Contact shadow, then the sprite (image / emoji / rect — Sprite decides).
    ctx.save();
    ctx.globalAlpha = this.game.palette.shadowAlpha * 0.85;
    ctx.fillStyle = this.game.palette.shadow;
    ctx.beginPath();
    // Shadow width is the object's real footprint — a wide pool under a
    // narrow-based book gives the grounding away.
    ctx.ellipse(this.x + this.width / 2, this.game.groundY + 2,
                this.width * (this.shadowWidth || 0.55), this.height * 0.07,
                0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Frame index only matters for animated strips; static PNGs ignore it.
    const frame = this.sprite.frames > 1
      ? Math.floor(this.time * this.sprite.fps)
      : 0;
    this.sprite.draw(ctx, this.x, this.y, this.width, this.height, frame);

    // Two plank lines so the placeholder crate reads as a crate.
    if (!this.sprite.isImageReady && !this.sprite.emoji) {
      ctx.save();
      ctx.strokeStyle = 'rgba(0,0,0,.18)';
      ctx.lineWidth = Math.max(1, this.game.scale);
      ctx.beginPath();
      ctx.moveTo(this.x + this.width * 0.15, this.y + this.height * 0.34);
      ctx.lineTo(this.x + this.width * 0.85, this.y + this.height * 0.34);
      ctx.moveTo(this.x + this.width * 0.15, this.y + this.height * 0.68);
      ctx.lineTo(this.x + this.width * 0.85, this.y + this.height * 0.68);
      ctx.stroke();
      ctx.restore();
    }

    if (this.game.debug) {
      const hb = this.getHitbox();
      ctx.save();
      ctx.strokeStyle = 'rgba(255,0,0,.9)';
      ctx.strokeRect(hb.x, hb.y, hb.w, hb.h);
      ctx.restore();
    }
  }
}


/** A cupcake. Bobs in place, pops on pickup, adds points. */
class Collectible extends Entity {
  /** @param {number} offsetX extra spawn distance to the right, in screen px. */
  constructor(game, offsetX, heightAboveGround) {
    const cfg = GameConfig.collectibles;
    const s = game.scale;
    super(game, {
      x: game.width + offsetX,
      width: cfg.width * s,
      height: cfg.height * s,
      sprite: new Sprite(cfg.render),
    });

    this.baseY = game.groundY - heightAboveGround * s - this.height;
    this.y = this.baseY;
    this.phase = Math.random() * Math.PI * 2;   // desync the bobbing
    this.time = 0;

    const inset = cfg.hitboxInset * s;          // negative -> bigger hitbox
    this.hitbox = { top: inset, right: inset, bottom: inset, left: inset };
  }

  update(dt, speed) {
    super.update(dt, speed);
    this.time += dt;
    const cfg = GameConfig.collectibles;
    this.y = this.baseY + Math.sin(this.time * cfg.bobSpeed + this.phase) * cfg.bobAmplitude * this.game.scale;
  }

  rescale(sizeRatio, widthRatio, groundDelta) {
    super.rescale(sizeRatio, widthRatio, groundDelta);
    this.baseY = this.baseY * sizeRatio + groundDelta;
  }

  draw(ctx) {
    // Soft glow so cupcakes pop against the background.
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = GameConfig.collectibles.render.color;
    ctx.beginPath();
    // Ellipse, not a circle: the sprite box is wider than it is tall, and a
    // circle sized off the width would balloon well past the top and bottom.
    ctx.ellipse(this.x + this.width / 2, this.y + this.height / 2,
                this.width * 0.62, this.height * 0.62, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    super.draw(ctx);

    if (this.game.debug) {
      const hb = this.getHitbox();
      ctx.save();
      ctx.strokeStyle = 'rgba(255,0,0,.9)';
      ctx.strokeRect(hb.x, hb.y, hb.w, hb.h);
      ctx.restore();
    }
  }
}


/** Dust / sparkle particle. Pure decoration, never collides. */
class Particle {
  constructor(x, y, { vx, vy, size, color, life, gravity = 0 }) {
    this.x = x; this.y = y;
    this.vx = vx; this.vy = vy;
    this.size = size;
    this.color = color;
    this.life = life;
    this.maxLife = life;
    this.gravity = gravity;
    this.dead = false;
  }

  update(dt, speed) {
    this.vy += this.gravity * dt;
    this.x += (this.vx - speed * 0.35) * dt;
    this.y += this.vy * dt;
    this.life -= dt;
    if (this.life <= 0) this.dead = true;
  }

  draw(ctx) {
    ctx.save();
    ctx.globalAlpha = Utils.clamp(this.life / this.maxLife, 0, 1);
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}


/** "+50" text that floats up and fades after collecting a cupcake. */
class FloatingText {
  constructor(x, y, text, scale) {
    this.x = x; this.y = y;
    this.text = text;
    this.life = 0.9;
    this.maxLife = 0.9;
    this.scale = scale;
    this.dead = false;
  }

  update(dt) {
    this.y -= 60 * this.scale * dt;
    this.life -= dt;
    if (this.life <= 0) this.dead = true;
  }

  draw(ctx) {
    ctx.save();
    ctx.globalAlpha = Utils.clamp(this.life / this.maxLife, 0, 1);
    ctx.fillStyle = GameConfig.player.colors.patch;
    ctx.font = `700 ${20 * this.scale}px "Trebuchet MS", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(this.text, this.x, this.y);
    ctx.restore();
  }
}


/** Parallax cloud. Wraps around instead of dying. */
class Cloud {
  constructor(game, x = null) {
    this.game = game;
    this.reset(x);
  }

  reset(x = null) {
    const g = this.game;
    this.width = Utils.rand(70, 150) * g.scale;
    this.height = this.width * Utils.rand(0.32, 0.5);
    this.x = x !== null ? x : g.width + this.width;
    this.y = Utils.rand(g.height * 0.06, g.groundY * 0.5);
    this.alpha = Utils.rand(0.45, 0.9);
  }

  update(dt, speed) {
    this.x -= speed * GameConfig.fx.cloudSpeedRatio * dt;
    if (this.x + this.width < 0) this.reset();
  }

  draw(ctx) {
    ctx.save();
    ctx.globalAlpha = this.alpha;
    ctx.fillStyle = this.game.palette.cloud;
    const w = this.width, h = this.height;
    ctx.beginPath();
    ctx.arc(this.x + w * 0.30, this.y + h * 0.60, h * 0.52, 0, Math.PI * 2);
    ctx.arc(this.x + w * 0.55, this.y + h * 0.42, h * 0.68, 0, Math.PI * 2);
    ctx.arc(this.x + w * 0.78, this.y + h * 0.62, h * 0.46, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}


/* =============================================================================
 * 7. GAME — owns the canvas, the loop, the entities and the state machine.
 *
 * States: 'ready' -> 'running' -> 'over' -> (restart) -> 'running'
 * ========================================================================== */
class Game {
  constructor(canvas, ui) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ui = ui;

    this.width = 0;          // logical (CSS) pixels — what all game code uses
    this.height = 0;
    this.scale = 1;          // SIZE   scale: design px -> screen px (see world config)
    this.speedScale = 1;     // MOTION scale: horizontal speed / spawn gaps
    this.groundY = 0;

    this.state = 'ready';
    this.debug = false;      // set true from the console to see the hitboxes

    this.obstacles = [];
    this.collectibles = [];
    this.particles = [];
    this.texts = [];
    this.clouds = [];

    // Initialised here too so the very first resize() can safely paint a frame.
    this.speed = GameConfig.world.baseSpeed;
    this.distance = 0;
    this.groundOffset = 0;
    this.lastTime = 0;
    this.rafId = null;
    this.shake = 0;

    this.best = Number(Storage.get(GameConfig.storageKey) || 0);

    this.audio = new AudioManager(GameConfig.audio);
    this.audio.load();

    // Canvas palette follows the OS theme (CSS does the same for the chrome).
    this.darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
    this.applyTheme();
    const onThemeChange = () => { this.applyTheme(); this.render(); };
    if (this.darkQuery.addEventListener) this.darkQuery.addEventListener('change', onThemeChange);
    else this.darkQuery.addListener(onThemeChange);   // Safari < 14
    new MutationObserver(onThemeChange).observe(document.documentElement,
      { attributes: true, attributeFilter: ['data-theme'] });

    this.resize();
    this.player = new Player(this);
    this.reset();

    this.ui.setBest(this.best);
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 120));
  }

  applyTheme() {
    const t = GameConfig.theme;
    // An explicit data-theme on <html> wins — some hosts (and the Artifact
    // viewer's own light/dark toggle) set it independently of the OS setting.
    const attr = document.documentElement.getAttribute('data-theme');
    const mode = t.force
      || (attr === 'dark' || attr === 'light' ? attr : null)
      || (this.darkQuery.matches ? 'dark' : 'light');
    this.palette = t[mode];
  }

  /* -------------------------------------------------------------------------
   * RESPONSIVENESS
   * Called on load, on resize and on orientation change.
   *   1. Read the real viewport (visualViewport when available: it excludes the
   *      mobile URL bar, which window.innerHeight does not always do).
   *   2. Size the canvas *backing store* by devicePixelRatio, then scale the
   *      context, so the drawing stays sharp on retina/AMOLED panels while all
   *      game code keeps working in simple CSS pixels.
   *   3. Recompute `scale` and `groundY`, then re-anchor every live entity so a
   *      mid-run resize (or a rotation) never drops the kitten out of the world.
   * ---------------------------------------------------------------------- */
  resize() {
    const vv = window.visualViewport;
    const cssWidth  = Math.round(vv ? vv.width  : window.innerWidth);
    const cssHeight = Math.round(vv ? vv.height : window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, GameConfig.loop.maxDPR);

    this.canvas.style.width = cssWidth + 'px';
    this.canvas.style.height = cssHeight + 'px';
    this.canvas.width  = Math.round(cssWidth  * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // 1 unit = 1 CSS pixel again

    const prevScale = this.scale;
    const prevGroundY = this.groundY;
    const prevWidth = this.width;

    this.width = cssWidth;
    this.height = cssHeight;

    const cfg = GameConfig.world;
    this.scale = Utils.clamp(
      Math.min(cssWidth / cfg.designWidth, cssHeight / cfg.designHeight),
      cfg.minScale, cfg.maxScale);
    this.speedScale = Utils.clamp(cssWidth / cfg.designWidth, cfg.minSpeedScale, cfg.maxSpeedScale);

    // Short/wide (landscape phone) screens need the ground lower to leave
    // vertical room for the jump arc; very tall ones need it lifted toward the
    // middle so the playfield isn't stranded at the bottom of the screen.
    const aspect = cssHeight / cssWidth;
    let ratio;
    if (aspect < 0.75) {
      ratio = cfg.groundRatioLandscape;
    } else if (aspect <= cfg.tallFrom) {
      ratio = cfg.groundRatio;
    } else {
      const t = Utils.clamp((aspect - cfg.tallFrom) / (cfg.tallTo - cfg.tallFrom), 0, 1);
      ratio = cfg.groundRatio + (cfg.groundRatioTall - cfg.groundRatio) * t;
    }
    this.groundY = cssHeight * ratio;

    // Re-anchor everything that already exists.
    if (prevScale) {
      const ratio = this.scale / prevScale;
      const widthRatio = prevWidth ? cssWidth / prevWidth : 1;
      const groundDelta = this.groundY - prevGroundY * ratio;
      for (const list of [this.obstacles, this.collectibles]) {
        for (const e of list) e.rescale(ratio, widthRatio, groundDelta);
      }
      if (this.player) {
        // Keep a mid-air kitten mid-air: remember its height over the old
        // ground line and restore it against the new one.
        const wasAirborne = !this.player.onGround;
        const airborneOffset = (this.player.y + this.player.height - prevGroundY) * ratio;
        const velocity = this.player.velocityY * ratio;
        this.player.syncToScreen();
        if (wasAirborne) {
          this.player.y = this.groundY + airborneOffset - this.player.height;
          this.player.velocityY = velocity;
          this.player.onGround = false;
        }
      }
      this.clouds.forEach(c => c.reset(Utils.rand(0, this.width)));
    }

    if (this.state !== 'running') this.render();   // repaint a paused/ready frame
  }

  /** Wipes the world back to a fresh run. */
  reset() {
    this.obstacles.length = 0;
    this.collectibles.length = 0;
    this.particles.length = 0;
    this.texts.length = 0;

    this.speed = GameConfig.world.baseSpeed;
    this.distance = 0;
    this.score = 0;
    this.cupcakes = 0;
    this.elapsed = 0;
    this.shake = 0;
    this.groundOffset = 0;
    this.deathTimer = 0;
    this.nextMilestone = GameConfig.world.milestone;

    this.obstacleGap = Utils.rand(GameConfig.obstacles.gapMin, GameConfig.obstacles.gapMax) * 1.6;
    this.collectibleGap = Utils.rand(GameConfig.collectibles.gapMin, GameConfig.collectibles.gapMax);

    this.clouds = Array.from({ length: GameConfig.fx.cloudCount },
      () => new Cloud(this, Utils.rand(0, this.width)));

    this.player.syncToScreen();
    this.ui.setScore(0);
    this.ui.setCupcakes(0);
  }

  /* ------------------------------- States -------------------------------- */

  start() {
    if (this.state === 'running') return;
    this.reset();
    this.state = 'running';
    // The death sound outlives the restart delay, so silence it explicitly
    // rather than letting it play over the top of the new run.
    this.audio.stop('hit');
    this.audio.play('meow');
    this.ui.hideOverlay();
    this.lastTime = performance.now();
    if (!this.rafId) this.rafId = requestAnimationFrame(t => this.loop(t));
  }

  gameOver() {
    if (this.state !== 'running') return;
    this.state = 'over';
    this.deathTimer = 0;
    this.shake = GameConfig.fx.shakeOnHit * this.scale;
    this.audio.play('hit');

    const score = Math.floor(this.score);
    if (score > this.best) {
      this.best = score;
      Storage.set(GameConfig.storageKey, String(this.best));
    }
    this.ui.setBest(this.best);
    this.ui.showGameOver(score, this.best, this.cupcakes);
    this.spawnDust(this.player.x + this.player.width / 2, this.player.y + this.player.height / 2, 16, '#e63946');
  }

  /** Single entry point for "the player pressed the action button". */
  handleAction() {
    if (this.state === 'ready') {
      this.start();
    } else if (this.state === 'running') {
      this.player.requestJump();
    } else if (this.state === 'paused') {
      this.togglePause();
    } else if (this.state === 'over' && this.deathTimer > GameConfig.input.restartDelay) {
      this.start();
    }
  }

  /** Pause key, and the resume path for every other input. */
  togglePause() {
    if (this.state === 'running') {
      this.state = 'paused';
      this.audio.pauseMusic();
      this.ui.showPaused();
    } else if (this.state === 'paused') {
      this.state = 'running';
      this.lastTime = performance.now();   // don't bank the paused seconds as dt
      this.audio.resumeMusic();
      this.ui.hideOverlay();
    }
  }

  handleRelease() {
    if (this.state === 'running') this.player.releaseJump();
  }

  /* --------------------------------- Loop -------------------------------- */

  /**
   * DELTA TIME
   * `timestamp` comes from requestAnimationFrame in milliseconds. We convert to
   * seconds and clamp it: if the tab was backgrounded for 10s, an unclamped dt
   * would move every entity 10 seconds' worth of pixels in a single step —
   * entities would teleport through each other and the kitten would fall through
   * the floor. Clamping to `loop.maxDelta` (50ms) makes the worst case a small,
   * survivable hiccup. Everything downstream multiplies by dt, which is what
   * makes the game run identically at 30, 60, 120 or 144 Hz.
   */
  loop(timestamp) {
    const dt = Utils.clamp((timestamp - this.lastTime) / 1000, 0, GameConfig.loop.maxDelta);
    this.lastTime = timestamp;

    this.update(dt);
    this.render();

    this.rafId = requestAnimationFrame(t => this.loop(t));
  }

  update(dt) {
    // Decorative layers keep drifting on the title / game-over screens.
    const worldSpeed = this.state === 'running' ? this.speed * this.speedScale : 0;
    const cloudSpeed = (this.state === 'running' ? this.speed : this.speed * 0.15) * this.speedScale;

    for (const cloud of this.clouds) cloud.update(dt, cloudSpeed);
    this.particles.forEach(p => p.update(dt, worldSpeed));
    this.texts.forEach(t => t.update(dt));
    this.particles = this.particles.filter(p => !p.dead);
    this.texts = this.texts.filter(t => !t.dead);
    this.shake *= Math.pow(0.001, dt);           // frame-rate independent decay

    if (this.state === 'over') { this.deathTimer += dt; return; }
    if (this.state !== 'running') return;

    this.elapsed += dt;

    // --- World acceleration: the game gets harder the longer you survive ----
    this.speed = Math.min(
      GameConfig.world.maxSpeed,
      GameConfig.world.baseSpeed + GameConfig.world.acceleration * this.elapsed
    );
    const speedPx = this.speed * this.speedScale;   // screen px per second

    this.distance += speedPx * dt;
    this.groundOffset = (this.groundOffset + speedPx * dt) % (40 * this.scale);

    this.player.update(dt);

    // --- Entities ----------------------------------------------------------
    this.obstacles.forEach(o => o.update(dt, speedPx));
    this.collectibles.forEach(c => c.update(dt, speedPx));
    this.obstacles = this.obstacles.filter(o => !o.dead);
    this.collectibles = this.collectibles.filter(c => !c.dead);

    this.spawnLogic(this.speed * dt);    // countdown runs in design px
    this.checkCollisions();

    // --- Score: design px travelled, so it means the same on every screen ---
    this.score += this.speed * dt * GameConfig.world.scorePerPixel;
    const shown = Math.floor(this.score);
    this.ui.setScore(shown);
    if (shown >= this.nextMilestone) {
      this.nextMilestone += GameConfig.world.milestone;
      this.ui.popScore();
    }
  }

  /* ------------------------------ Spawning -------------------------------- */

  /**
   * Distance-driven spawning (not timer-driven): we count down the pixels that
   * scrolled by, so the *spatial* gap between obstacles stays consistent even as
   * the world speeds up. `gapSpeedBias` then stretches the gap a little at high
   * speed so a fast run stays reactable.
   */
  spawnLogic(travelledDesignPx) {
    const oCfg = GameConfig.obstacles;
    const cCfg = GameConfig.collectibles;
    const speedFactor = 1 + (this.speed / GameConfig.world.baseSpeed - 1) * oCfg.gapSpeedBias;

    this.obstacleGap -= travelledDesignPx;
    if (this.obstacleGap <= 0) {
      this.spawnObstacle();
      this.obstacleGap = Utils.rand(oCfg.gapMin, oCfg.gapMax) * speedFactor;
    }

    this.collectibleGap -= travelledDesignPx;
    if (this.collectibleGap <= 0) {
      this.spawnCollectibles();
      this.collectibleGap = Utils.rand(cCfg.gapMin, cCfg.gapMax) * speedFactor;
    }
  }

  spawnObstacle() {
    const variant = Utils.weightedPick(GameConfig.obstacles.variants);
    const count = variant.count || 1;
    for (let i = 0; i < count; i++) {
      // Stacked crates must stay glued together, so this offset is a *size*
      // and uses the size scale, not the motion scale.
      const offset = i * (variant.width + (variant.spacing || 0)) * this.scale;
      this.obstacles.push(new Obstacle(this, variant, offset));
    }
  }

  /**
   * The jump, measured rather than guessed. Everything falls out of gravity and
   * jump strength, so it stays correct if the physics are retuned.
   */
  get jumpArc() {
    const P = GameConfig.player;
    return {
      airtime: 2 * P.jumpStrength / P.gravity,                    // seconds
      apex: Math.pow(P.jumpStrength, 2) / (2 * P.gravity),        // design px
      get reach() { return this.apex + P.height; },               // design px
      spanPx: this.speed * this.speedScale * (2 * P.jumpStrength / P.gravity),
    };
  }

  /**
   * Signed screen-px gaps from `centreX` to every obstacle; + is ahead.
   *
   * Obstacles and collectibles scroll at exactly the same speed, so the gap
   * between any two is fixed the moment both exist. That means it can be
   * settled up front — including for obstacles that haven't spawned yet.
   */
  obstacleOffsets(centreX) {
    const offsets = this.obstacles.map(o => (o.x + o.width / 2) - centreX);

    /* Unspawned obstacles still have to be avoided. The next one is known
     * exactly — obstacleGap is its remaining countdown. The two after it are
     * only bounded, so they're projected at the MINIMUM gap: as early as they
     * could possibly arrive, which is the conservative assumption. Without
     * this a group can be slid forward into an obstacle that simply didn't
     * exist yet when the slot was chosen. */
    const oCfg = GameConfig.obstacles;
    const widest = Math.max(...oCfg.variants.map(v => v.width));
    let ahead = this.obstacleGap;
    for (let i = 0; i < 3; i++) {
      offsets.push(this.width + (widest * this.scale) / 2
                   + ahead * this.speedScale - centreX);
      ahead += oCfg.gapMin;
    }
    return offsets;
  }

  /**
   * Spawn a pastelito group that is always worth taking.
   *
   * Measured first: a bot chasing pastelitos died 18 times against 11 for one
   * ignoring them, and instrumenting those deaths showed 20 of 22 happened
   * mid-air, a median 0.82s after take-off against a 0.74s airtime. The cat was
   * never hitting things on the way up — it was coming down onto them.
   *
   * So placement is about the LANDING window, not proximity: slide the group
   * forward until no obstacle sits where the cat comes down.
   */
  spawnCollectibles() {
    const cfg = GameConfig.collectibles;
    const ARC = 45;                       // mid-group lift, design px
    const group = Math.random() < cfg.groupChance
      ? Utils.randInt(cfg.groupSize[0], cfg.groupSize[1])
      : 1;

    const span = this.jumpArc.spanPx;
    let spacingPx = cfg.groupSpacing * this.speedScale;

    // Keep a group inside one airborne window rather than trailing out of it.
    if (group > 1) {
      spacingPx = Math.min(spacingPx, (span * cfg.comboSpread) / (group - 1));
    }

    const centre0 = this.width + ((group - 1) * spacingPx) / 2;
    const offsets = this.obstacleOffsets(centre0);

    const unsafe = (shift) => offsets.some(o => {
      const d = o - shift;
      return d > span * cfg.landingFrom && d < span * cfg.landingTo;
    });

    /* Slide forward until EVERY obstacle's landing window is clear. Aligning to
     * just the nearest one fixes one pairing and can shove the group straight
     * into another. Spawning happens off-screen, so sliding right is free. */
    let shift = null;
    for (let s = 0; s <= span * 2; s += span * 0.05) {
      if (!unsafe(s)) { shift = s; break; }
    }
    if (shift === null) return;           // no safe slot: skip, try again later

    // Sitting above an obstacle means clearing its height too.
    const overObstacle = offsets.some(o => Math.abs(o - shift) < span * cfg.landingFrom);
    const high = overObstacle || Math.random() < cfg.highChance;

    // Ceiling from the real arc, so a good jump always reaches the group.
    const ceiling = this.jumpArc.reach * cfg.reachSafety - ARC;
    const base = Math.min(high ? cfg.highHeight : cfg.lowHeight, ceiling);

    for (let i = 0; i < group; i++) {
      const arc = group > 1 ? Math.sin((i / (group - 1)) * Math.PI) * ARC : 0;
      this.collectibles.push(new Collectible(this, shift + i * spacingPx, base + arc));
    }
  }

  /* ----------------------------- Collisions ------------------------------- */

  /**
   * Brute force: the kitten's hitbox against every obstacle, then every cupcake.
   * With ~10 live entities this is a handful of comparisons per frame — adding
   * spatial partitioning here would be pure ceremony. If you ever spawn
   * hundreds of entities, sort by x and break out of the loop once
   * `entity.x > player.right`, since the arrays are already ordered.
   */
  checkCollisions() {
    const playerBox = this.player.getHitbox();

    for (const obstacle of this.obstacles) {
      if (Utils.intersects(playerBox, obstacle.getHitbox())) {
        this.gameOver();
        return;                       // one death is enough
      }
    }

    for (const cupcake of this.collectibles) {
      if (cupcake.dead) continue;
      if (Utils.intersects(playerBox, cupcake.getHitbox())) {
        cupcake.dead = true;
        this.cupcakes++;
        this.score += GameConfig.collectibles.points;
        this.ui.setCupcakes(this.cupcakes);
        this.audio.play('pickup');
        this.texts.push(new FloatingText(
          cupcake.x + cupcake.width / 2, cupcake.y,
          `+${GameConfig.collectibles.points}`, this.scale));
        this.spawnSparkles(cupcake.x + cupcake.width / 2, cupcake.y + cupcake.height / 2);
      }
    }
  }

  /* -------------------------------- FX ------------------------------------ */

  spawnDust(x, y, count, color = null) {
    if (!GameConfig.fx.particles || this.particles.length > GameConfig.fx.maxParticles) return;
    const s = this.scale;
    color = color || this.palette.dust;
    for (let i = 0; i < count; i++) {
      this.particles.push(new Particle(x, y, {
        vx: Utils.rand(-90, 40) * s,
        vy: Utils.rand(-140, -20) * s,
        size: Utils.rand(1.5, 4) * s,
        color,
        life: Utils.rand(0.25, 0.55),
        gravity: 900 * s,
      }));
    }
  }

  spawnSparkles(x, y) {
    if (!GameConfig.fx.particles) return;
    const s = this.scale;
    const colors = ['#ff8fab', '#ffd166', '#ffffff', '#e63946'];
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      this.particles.push(new Particle(x, y, {
        vx: Math.cos(angle) * Utils.rand(80, 220) * s,
        vy: Math.sin(angle) * Utils.rand(80, 220) * s,
        size: Utils.rand(2, 4.5) * s,
        color: colors[i % colors.length],
        life: Utils.rand(0.3, 0.7),
        gravity: 320 * s,
      }));
    }
  }

  /* ------------------------------ Rendering ------------------------------- */

  render() {
    if (!this.player) return;          // first resize() runs before the kitten exists
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

    ctx.save();
    if (this.shake > 0.5) {
      ctx.translate(Utils.rand(-this.shake, this.shake), Utils.rand(-this.shake, this.shake));
    }

    this.drawBackground(ctx);
    // Clouds belong to the painted sky. With sky art in place they'd drift
    // across it as stray blobs — indoors, in the café's case — so they step
    // aside for the same reason the painted hills do.
    if (!this._sky || !this._sky.isImageReady) {
      this.clouds.forEach(c => c.draw(ctx));
    }
    this.drawGround(ctx);

    this.collectibles.forEach(c => c.draw(ctx));
    this.obstacles.forEach(o => o.draw(ctx));
    this.player.draw(ctx);

    this.particles.forEach(p => p.draw(ctx));
    this.texts.forEach(t => t.draw(ctx));

    ctx.restore();
  }

  /**
   * Rebuild the sky/ground Sprites whenever their configured `src` changes, so
   * map art can be swapped live from the console without a reload:
   *     GameConfig.theme.groundImage.src = 'assets/floor.png'
   * Two string compares per frame — cheaper than the branch it saves.
   */
  syncBackdrop() {
    const t = GameConfig.theme;
    if (this._skySrc !== t.skyImage.src) {
      this._skySrc = t.skyImage.src;
      this._sky = t.skyImage.src ? new Sprite(t.skyImage) : null;
    }
    if (this._groundSrc !== t.groundImage.src) {
      this._groundSrc = t.groundImage.src;
      this._ground = t.groundImage.src ? new Sprite(t.groundImage) : null;
    }
  }

  drawBackground(ctx) {
    this.syncBackdrop();
    const cfg = GameConfig.theme.skyImage;

    // --- Pixel-art sky, when one is configured and has finished loading ------
    if (this._sky && this._sky.isImageReady) {
      if (cfg.mode === 'tile') {
        this._sky.drawTiled(ctx, 0, 0, this.width, this.groundY,
                            this.distance * cfg.speedRatio);
      } else {
        this._sky.draw(ctx, 0, 0, this.width, this.groundY);
      }
      return;   // the artwork carries its own horizon; the painted hills below
                // would only fight it
    }

    // --- Painted fallback ----------------------------------------------------
    // Sky gradient (the CSS one is only a fallback for the first paint).
    const sky = ctx.createLinearGradient(0, 0, 0, this.groundY);
    sky.addColorStop(0, this.palette.skyTop);
    sky.addColorStop(1, this.palette.skyBottom);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, this.width, this.groundY);

    // Parallax hills: one sine wave scrolled slower than the world.
    const offset = (this.distance * GameConfig.fx.hillSpeedRatio) % (this.width || 1);
    ctx.save();
    ctx.fillStyle = this.palette.hills;
    ctx.beginPath();
    ctx.moveTo(0, this.groundY);
    const step = 20;
    for (let x = 0; x <= this.width; x += step) {
      const t = (x + offset) * 0.006;
      const y = this.groundY - (Math.sin(t) * 0.5 + Math.sin(t * 0.5) * 0.5 + 1) * 45 * this.scale;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(this.width, this.groundY);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  drawGround(ctx) {
    const g = this.groundY;
    const cfg = GameConfig.theme.groundImage;

    // --- Pixel-art floor -----------------------------------------------------
    if (this._ground && this._ground.isImageReady) {
      // Solid fill underneath first: a strip shorter than the floor area would
      // otherwise leave the bottom of the screen showing the sky behind it.
      ctx.fillStyle = this.palette.ground;
      ctx.fillRect(0, g, this.width, this.height - g);

      // Lift the strip so the art's walking surface — not its top edge — lands
      // on the ground line. Whatever sits above it (chair backs) paints over
      // the sky, and the cat draws afterwards, so it runs in front of them.
      const top = g - (cfg.offsetY || 0) * this.scale;
      const stripH = cfg.height ? cfg.height * this.scale : this.height - top;
      if (cfg.mode === 'stretch') {
        this._ground.draw(ctx, 0, top, this.width, stripH);
      } else {
        this._ground.drawTiled(ctx, 0, top, this.width, stripH,
                               this.distance * cfg.speedRatio);
      }
      return;   // the art supplies its own edge and surface detail, so the
                // painted line and speed dashes are skipped
    }

    // --- Painted fallback ----------------------------------------------------
    // Solid floor below the line.
    ctx.fillStyle = this.palette.ground;
    ctx.fillRect(0, g, this.width, this.height - g);

    // The line itself.
    ctx.strokeStyle = this.palette.groundLine;
    ctx.lineWidth = Math.max(2, 2 * this.scale);
    ctx.beginPath();
    ctx.moveTo(0, g);
    ctx.lineTo(this.width, g);
    ctx.stroke();

    // Scrolling dashes: cheap, readable sense of speed.
    ctx.strokeStyle = this.palette.groundDash;
    ctx.lineWidth = Math.max(1, 1.5 * this.scale);
    const spacing = 40 * this.scale;
    ctx.beginPath();
    for (let x = -this.groundOffset; x < this.width; x += spacing) {
      const y = g + ((x | 0) % 3 === 0 ? 12 : 20) * this.scale;
      ctx.moveTo(x, y);
      ctx.lineTo(x + 14 * this.scale, y);
    }
    ctx.stroke();
  }
}


/* =============================================================================
 * 8. UI + INPUT + BOOTSTRAP
 * ========================================================================== */

/**
 * Pre-premiere lock: black screen, countdown, no game. Unlocks itself the
 * instant the release date passes, so nobody has to reload at midnight.
 *
 * Deliberately fails OPEN — an unparseable date leaves the game playable
 * rather than bricking it behind a countdown that never ends.
 */
class PrePremiere {
  constructor(cfg) {
    this.cfg = cfg;
    this.el      = document.getElementById('prepremiere');
    this.eyebrow = document.getElementById('pp-eyebrow');
    this.title   = document.getElementById('pp-title');
    this.note    = document.getElementById('pp-date');
    this.parts   = ['d', 'h', 'm', 's'].map(k => document.getElementById('pp-' + k));

    this.target = new Date(cfg.releaseDate).getTime();
    this.bypassed = new URLSearchParams(location.search).has(cfg.bypassParam);
    this.timer = null;
  }

  get locked() {
    if (!this.cfg.enabled || this.bypassed) return false;
    if (!Number.isFinite(this.target)) {
      console.warn(`[PrePremiere] releaseDate "${this.cfg.releaseDate}" is not a ` +
                   `valid date — leaving the game unlocked.`);
      return false;
    }
    return Date.now() < this.target;
  }

  /** Show the lock and tick it; calls onUnlock once, when the date arrives. */
  start(onUnlock) {
    if (!this.locked) return;

    this.eyebrow.textContent = this.cfg.eyebrow;
    this.title.textContent = this.cfg.title;
    this.note.textContent = this.cfg.dateNote;
    this.el.hidden = false;

    const tick = () => {
      if (!this.locked) {
        clearInterval(this.timer);
        this.el.hidden = true;
        onUnlock();
        return;
      }
      const total = Math.max(0, Math.floor((this.target - Date.now()) / 1000));
      const values = [
        Math.floor(total / 86400),
        Math.floor(total / 3600) % 24,
        Math.floor(total / 60) % 60,
        total % 60,
      ];
      this.parts.forEach((el, i) => {
        el.textContent = String(values[i]).padStart(2, '0');
      });
    };
    tick();
    this.timer = setInterval(tick, 250);
  }
}


/** Thin wrapper over the DOM so the Game never touches querySelector. */
class UI {
  constructor() {
    this.scoreEl    = document.getElementById('score');
    this.bestEl     = document.getElementById('best');
    this.cupcakeEl  = document.getElementById('cupcakes');
    this.overlay    = document.getElementById('overlay');
    this.title      = document.getElementById('overlay-title');
    this.text       = document.getElementById('overlay-text');
    this.stats      = document.getElementById('overlay-stats');
    this.finalScore = document.getElementById('final-score');
    this.finalBest  = document.getElementById('final-best');
    this.finalCakes = document.getElementById('final-cupcakes');
    this.button     = document.getElementById('action-btn');
  }

  setScore(v)    { this.scoreEl.textContent = String(v).padStart(4, '0'); }
  setBest(v)     { this.bestEl.textContent  = String(v).padStart(4, '0'); }
  // Just the number — the pastelito icon beside it is a separate <img> in the
  // markup, so writing textContent here can't clobber it.
  setCupcakes(v) { this.cupcakeEl.textContent = String(v); }

  popScore() {
    this.scoreEl.classList.remove('pop');
    void this.scoreEl.offsetWidth;      // force reflow to replay the animation
    this.scoreEl.classList.add('pop');
  }

  hideOverlay() {
    this.overlay.classList.remove('is-visible');
  }

  /** Proper method instead of the input layer reaching in and poking the DOM. */
  showPaused() {
    this.overlay.dataset.state = 'paused';
    this.title.textContent = 'PAUSA';
    this.text.textContent  = '😴😴😴';
    this.stats.hidden = true;
    this.button.textContent = 'SEGUIR';
    this.overlay.classList.add('is-visible');
  }

  showGameOver(score, best, cupcakes) {
    this.overlay.dataset.state = 'over';
    this.title.textContent = score >= best && score > 0 ? 'MEJOR PUNTUACION!' : 'GAME OVER';
    this.text.textContent  = 'PERDISTE!!';
    this.stats.hidden = false;
    this.finalScore.textContent = score;
    this.finalBest.textContent  = best;
    this.finalCakes.textContent = cupcakes;
    this.button.textContent = 'REINTENTAR';
    this.overlay.classList.add('is-visible');
  }
}


/**
 * INPUT
 * - pointerdown/up on the document covers mouse, touch and pen in one listener
 *   (touchstart is added only as a fallback for engines without Pointer Events).
 * - preventDefault on touch stops the synthetic mouse event, the 300ms delay and
 *   any double-tap zoom that slips past the viewport meta tag.
 * - keydown uses `event.repeat` so holding the key doesn't machine-gun jumps.
 */
function bindInput(game) {
  const supportsPointer = 'onpointerdown' in window;

  // Buttons handle their own clicks; the global jump listener must not also
  // fire for taps that land on them.
  const onButton = (event) => !!(event.target && event.target.closest &&
    event.target.closest('#action-btn, #pause-btn, #mute-btn'));

  const press = (event) => {
    // Browsers only allow audio once the user has interacted, so every input
    // path unlocks it first. Cheap and idempotent after the first call.
    game.audio.unlock();
    if (onButton(event)) return;
    if (event.cancelable) event.preventDefault();
    game.handleAction();
  };
  const release = (event) => {
    if (onButton(event)) return;
    if (event.cancelable) event.preventDefault();
    game.handleRelease();
  };

  if (supportsPointer) {
    document.addEventListener('pointerdown', press, { passive: false });
    document.addEventListener('pointerup', release, { passive: false });
    document.addEventListener('pointercancel', release, { passive: false });
  } else {
    document.addEventListener('touchstart', press, { passive: false });
    document.addEventListener('touchend', release, { passive: false });
    document.addEventListener('mousedown', press);
    document.addEventListener('mouseup', release);
  }

  const JUMP_KEYS = new Set(['Space', 'ArrowUp', 'KeyW', 'Enter', 'NumpadEnter']);

  document.addEventListener('keydown', (event) => {
    if (!JUMP_KEYS.has(event.code)) return;
    event.preventDefault();             // stop Space from scrolling / re-clicking
    game.audio.unlock();                // keyboard counts as a user gesture too
    if (event.repeat) return;
    game.handleAction();
  });

  document.addEventListener('keyup', (event) => {
    if (!JUMP_KEYS.has(event.code)) return;
    game.handleRelease();
  });

  // The overlay button is the only pointer-events:auto element on top.
  document.getElementById('action-btn').addEventListener('click', (event) => {
    event.stopPropagation();
    game.handleAction();
  });

  document.getElementById('pause-btn').addEventListener('click', (event) => {
    event.stopPropagation();
    game.audio.unlock();
    game.togglePause();
  });

  /* Two independent toggles: effects and music. Each paints itself from the
   * manager's state, so the restored-from-storage value and the post-click
   * value go through the same path. */
  const bindToggle = (id, onGlyph, offGlyph, initial, toggle) => {
    const el = document.getElementById(id);
    const paint = (muted) => {
      el.dataset.muted = muted ? '1' : '0';
      el.textContent = muted ? offGlyph : onGlyph;
    };
    paint(initial);                       // restore last session's choice
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      game.audio.unlock();
      paint(toggle());
    });
  };

  bindToggle('mute-btn', '🔊', '🔇', game.audio.mutedSfx,
             () => game.audio.toggleSfx());
  bindToggle('music-btn', '🎵', '🔕', game.audio.mutedMusic,
             () => game.audio.toggleMusic());

  // Belt and braces against pinch-zoom / double-tap-zoom on iOS Safari.
  document.addEventListener('gesturestart', e => e.preventDefault(), { passive: false });
  document.addEventListener('dblclick', e => e.preventDefault(), { passive: false });
  document.addEventListener('contextmenu', e => e.preventDefault());

  // Escape toggles both ways, same as the pause key.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') game.togglePause();
  });

  // Auto-pause: losing focus mid-run shouldn't cost you the run. Music stops
  // whatever the state was, so the game is never heard from a buried tab.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (game.state === 'running') game.togglePause();
      else game.audio.pauseMusic();
    } else if (game.state !== 'paused') {
      game.audio.resumeMusic();
    }
  });
}

/**
 * The strict viewport meta lives in index.html — but when the game is embedded
 * in a host that supplies its own document shell, that tag isn't there, and
 * without it fast tapping triggers double-tap zoom. Guarantee it at runtime.
 */
function ensureViewport() {
  let meta = document.querySelector('meta[name="viewport"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'viewport');
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', 'width=device-width, initial-scale=1.0, ' +
    'maximum-scale=1.0, user-scalable=no, viewport-fit=cover');
}


/* ------------------------------- Start it up ------------------------------ */
window.addEventListener('DOMContentLoaded', () => {
  ensureViewport();
  const canvas = document.getElementById('game');
  const ui = new UI();
  const game = new Game(canvas, ui);

  /* Pre-premiere gate. The lock is opaque and takes pointer events, so the
   * game underneath can't be seen or touched — and input is only wired once it
   * lifts, so a stray keypress can't start a run behind it either. When the
   * date passes mid-visit the lock removes itself and wires input then. */
  const gate = new PrePremiere(GameConfig.prePremiere);
  if (gate.locked) {
    gate.start(() => bindInput(game));
  } else {
    bindInput(game);
  }

  /* Queue the music. It can't actually start until the player interacts —
   * that's the autoplay policy, not a bug — so this only marks it as wanted;
   * AudioManager.unlock() starts it for real. Behind the pre-premiere lock
   * input isn't even bound, so nothing is fetched or heard until launch. */
  game.audio.startMusic();

  // Draw the idle frame behind the title screen and keep it animating.
  game.lastTime = performance.now();
  game.rafId = requestAnimationFrame(t => game.loop(t));

  // Handy from the browser console: window.game.debug = true  -> show hitboxes
  //                                 window.GameConfig...      -> live tuning
  window.game = game;
  window.GameConfig = GameConfig;
  window.prePremiere = gate;
});
