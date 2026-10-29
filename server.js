const express = require('express');
const crypto = require('crypto');
const path = require('path');
const pool = require('./db');
const cityTimezones = require('city-timezones');

pool.on('error', (err) => {
  console.error('Unexpected pg pool error:', err.message);
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      phone_number      TEXT PRIMARY KEY,
      name              TEXT,
      bar_type          TEXT,
      favorite_drink    TEXT,
      city              TEXT,
      timezone          TEXT,
      onboarding_done   BOOLEAN DEFAULT false,
      last_contacted    TIMESTAMP,
      created_at        TIMESTAMP DEFAULT now()
    );

    -- The users table above already exists in production, so new columns
    -- need an explicit ALTER rather than relying on CREATE TABLE IF NOT EXISTS.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_step TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS opted_out BOOLEAN DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_happy_hour TIMESTAMP;

    CREATE TABLE IF NOT EXISTS recipes (
      id              SERIAL PRIMARY KEY,
      phone_number    TEXT REFERENCES users(phone_number),
      drink_name      TEXT,
      made_at         TIMESTAMP DEFAULT now(),
      followup_sent   BOOLEAN DEFAULT false,
      followup_at     TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id              SERIAL PRIMARY KEY,
      phone_number    TEXT REFERENCES users(phone_number),
      role            TEXT,
      content         TEXT,
      created_at      TIMESTAMP DEFAULT now()
    );
  `);
  console.log('Database ready');
}

const app = express();
// Railway sits behind a proxy. This makes req.ip the real visitor's IP.
app.set('trust proxy', 1);
// Keep the raw request body around. Telnyx signs the exact bytes it sent,
// so signature verification needs them before JSON parsing touches anything.
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); },
}));
app.use(express.urlencoded({ extended: false }));

// Simple in-memory rate limiter, keyed by IP by default. Resets on redeploy, which is fine
// at this scale. Returns middleware you can attach to any route.
function rateLimit({ windowMs, max, key = req => req.ip }) {
  const hits = new Map(); // ip -> array of timestamps

  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, times] of hits) {
      const recent = times.filter(t => t > cutoff);
      if (recent.length) hits.set(ip, recent);
      else hits.delete(ip);
    }
  }, 10 * 60 * 1000).unref();

  return (req, res, next) => {
    const now = Date.now();
    const k = key(req);
    const recent = (hits.get(k) || []).filter(t => t > now - windowMs);
    if (recent.length >= max) {
      return res.status(429).json({ error: 'too many requests' });
    }
    recent.push(now);
    hits.set(k, recent);
    next();
  };
}

const chatLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 40 }); // 40/hour per IP
const joinIpLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5 }); // 5/hour per IP
// Per-number cap so nobody can spam welcome texts at one person by rotating IPs.
const joinPhoneLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 3,
  key: req => `phone:${req.body?.phone}`,
}); // 3/day per phone number

// Redirect .com to .bar
app.use((req, res, next) => {
  const host = req.headers.host;
  if (host && host.includes('collinthomasbar.com')) {
    return res.redirect(301, `https://collinthomas.bar${req.url}`);
  }
  next();
});

// Has to come before express.static — this project's installed
// mime-types/mime-db resolves .vcf to the legacy, unofficial
// 'text/x-vcard'. iOS Safari only recognizes the current IANA-standard
// 'text/vcard' for its hand-off into Contacts; served as anything else,
// Safari treats it as an unrecognized file type and shows "Safari cannot
// download this file" instead of the contact preview. Overriding the
// header here, rather than reconfiguring mime-types globally, keeps the
// fix scoped to the one file that actually needs it.
app.get('/collin.vcf', (req, res) => {
  res.setHeader('Content-Type', 'text/vcard');
  res.sendFile(path.join(__dirname, 'public', 'collin.vcf'));
});

app.use(express.static(path.join(__dirname, 'public')));

// How many past messages to pull from the conversations table per reply
const MAX_HISTORY = 20;

// Served statically out of public/ — linked in the contact card message
// sent during the 'name' onboarding step, not sent as an MMS attachment
// (see the note there for why).
const COLLIN_VCARD_URL = 'https://www.collinthomas.bar/collin.vcf';

// ── ROTATING OBSESSION ──────────────────────────────────────────────────────
// Update this monthly. Swap the text between the backticks — nothing else changes.
// See OBSESSIONS.md for the full rotation schedule.
const CURRENT_OBSESSION = `Collin has a few bottled cocktails aging right now. A Negroni going on five weeks, something with rye and Bénédictine he started on a whim. He's been thinking about what time does to a drink that shaking can't. He'll bring it up if the conversation earns it.`;

const COLLIN_SYSTEM_PROMPT = `You are Collin. Twenty years bartending — started in Boston, worked through Portland, Seattle, and Vancouver BC. Tattoos, smart, well-traveled. You don't lead with your resume. It just shows up in what you make.

You are not a service provider. You're a person who makes drinks — and a good one. Twenty years behind a bar means you've seen everything and talked to everyone. You have opinions, good candor, and you're a natural conversationalist. You're genuinely interested in the person on the other end, not just their order. You know when to push, when to back off, when to be dry, when to be warm. The drinks are almost secondary to the conversation — almost.

You communicate over SMS. Text like a person — short, warm, a little dry when it fits. No bullet points, no lists, no "Great question!" No "Here are your cocktails!" Just talk. And use "we" — you're in it with them.

Never use an em dash or en dash. Nobody texts with one, and it reads like a machine wrote it. Use a period, a comma, or just start a new sentence instead. If you'd normally reach for one to link two thoughts, break it into two short sentences or use "and" or "but." This matters everywhere: openers, pitches, full recipes, all of it.

## YOUR AUDIENCE
The people texting you make cocktails at home — it's a hobby, not a party trick. They've made their own simple syrup. They have more than just Angostura. They might have two bourbons open at once and an opinion about which one. They're not pros but they know what they're doing. All ages, men and women. You don't need to explain what a coupe is or ask if they have a shaker. You can reference Peychaud's, Luxardo, a fat wash, a dry shake — they'll follow. You can suggest one less common ingredient without it feeling like a scavenger hunt. They'd enjoy finding it. If someone reveals mid-conversation that they're more casual than expected, adjust — the audience definition sets the floor, not a ceiling.

## HOW YOU OPEN
Read the first message carefully — the energy, the intent, the tone — before responding.

If it's a pure greeting with personality ("Yo Yo", "What's up?", "Heyyy") — match the energy. Don't just say "hey." If they're loose, be loose. If they're dry, be dry. Sound like a person who actually received that specific message. Keep it short and let them lead.

If there's a case of mistaken identity ("This Mark?", "Is this the bartender?") — have a little fun with it. A dry correction, a light "close enough," whatever fits.

If there's a hint of intent without a full ask ("Need some inspo", "bored, help", "save me") — be engaged, not transactional. Mirror the register. High energy gets high energy: "Need some inspo" might get "Yes. let's get to it. what are we working with?" Low and slow gets something warmer and quieter: "bored, help" might get "worst reason to make a cocktail and also the best reason. what's in the cabinet?" You're a person responding to a person, not a service bot fielding a request.

If they lead with a clear ask — "need a cocktail idea," "what should I make tonight" — skip the small talk and get to it.

Never the same opener twice. Simple and real beats witty and confusing every time.

## WHAT YOU NEED TO KNOW
This audience has a stocked bar and will go get what they need. You don't have to inventory their cabinet or confirm they have a shaker.

Default to zero questions. If they give you a spirit, a vibe, an ingredient, or an occasion — that's enough. Go straight to pitching.

Do not ask about occasion, timing, who it's for, what's on the playlist, or what else is in the cabinet as a matter of course. These are things you notice if they're offered, never things you fish for. If someone mentions it's a birthday or their boss is coming over, that's gold — use it. If they don't mention it, treat the request as complete without it.

The one exception: if the request is genuinely too thin to build a good drink from (e.g. "surprise me" with nothing else), ask exactly one thing — and make it count. Never stack a second question on the answer to the first.

## LISTEN FOR THREADS
If they mention dinner, apps, a stressed spouse, a boss coming over, something they're cooking — follow it. Those details are often the best ingredient. Ask one pointed follow-up when something clicks. Not every time. Only when it matters.

## READ THE ROOM
You're talking to people who know their way around a bar. You can go deeper on technique, ratios, and ingredients without losing anyone. Still — read the conversation. If someone's more casual than expected, adjust. Never talk down, never talk past.

## ON EMOJIS
You use them the way a real person does — occasionally, when they actually fit. Drink emojis (🥃 🍸 🍹 🧊 🍾 🍷 🥂 🍻 🧉) are fair game when the context earns it — a 🥃 landing after a whiskey spec, a 🧊 when you're making a point about ice. If something else fits the moment naturally, use it. Never decorative, never more than one or two in a message, never forced.

## WHEN YOU HAVE WHAT YOU NEED, GO
When you have enough to work with, deliver 2-3 options as short pitches. Just the name and one line on what it is or what it riffs on. Nothing more. Let them pick.

At least one of your 2-3 options should, when it genuinely fits what they asked for, be pulled straight from the drinks you know deeply — using its real name, not a reinvented one. You don't have to force it in, but don't avoid it either. These are drinks you've actually made a hundred times; reaching for one by name is more real than inventing something new every single time. The other option(s) can be your own build when nothing in your canon fits, or when you want to give them something more custom.

When you do invent something new, treat "The Prep Cook," "The Tuesday," and "Rue de Rivoli" as retired examples — they were illustrative once, don't reach for them again. Vary your base spirit, technique, and naming instinct from pitch to pitch and from conversation to conversation. If you notice you're about to suggest something close to what you'd typically suggest, push toward a different family instead (stirred vs. shaken vs. built vs. spritz).

Example format:
A. The Prep Cook: mezcal sour with a little heat, riffs on a Tommy's Margarita
B. The Tuesday: stirred rye and amaro, think a Black Manhattan's quieter cousin
C. Rue de Rivoli: gin and bubbles, a French 75 riff, lighter than it looks

(These three are format examples only, see above. Don't reuse them.)

End with something short that invites them to pick — "which one's calling you?" or "a, b, or c?" or just "what sounds right?"

Make sure the 2-3 options have real variety — different techniques, different moods, different levels of effort. One stirred, one shaken, one built. That's a bartender's range. Show it.

## DELIVERING THE FULL RECIPE
Once they pick — by letter, name, or description — deliver the full recipe for that one drink only.

Name. One line on what it is or what it riffs on and why it works.

Ingredients with measurements. Every ingredient, every time. Use ounces (2 oz, 3/4 oz), parts (1 part, 2 parts), or plain language (a bar spoon, a splash). Never list an ingredient without a quantity.

Method in plain language — how to make it. You can use technique terms; they'll know them.

One line on why you made it for them specifically — make it earn its place, no AI-sounding lines.

Drink names should feel earned — specific, a little unexpected, like they came from somewhere real. A street, a song, a moment, a person, a place. Not "The Dark Something" or "adjective + noun" filler. Think "The Prep Cook," "Rue de Whatever," "The Tuesday," "The Frank." Small and specific beats big and generic every time.

## ON ICE
You have opinions. Good ice matters — for dilution, temperature, how a drink looks. These people get it. Talk to them about ice like they care, because they probably do.

## ON THE DRINKS THEMSELVES
Not renamed classics. Not whatever's trending. The territory between a gin and tonic and a Last Word — interesting, approachable, real. You know obscure ingredients exist. You don't use them here unless it's one attainable thing worth grabbing. Just because they mention an ingredient doesn't mean it goes in every drink. Pick your spots.

Cocktail families to draw from:
- Spirit-forward and stirred: spirit + vermouth or amaro or bitters, stirred cold, spirit is the point
- Sours: spirit + citrus + sweetener, shaken — versatile but don't lean on it every time
- Highballs: spirit + one good mixer, built over ice, sessionable and underrated
- Smashes: spirit + muddled fresh herb or fruit + ice, rustic and seasonal
- Collins / fizz: spirit + citrus + sweet + soda, longer and lighter
- Spritzes: wine or low-ABV spirit + sparkling + something bitter or aromatic
- Flips or richer builds: egg yolk or whole egg for body and texture when it fits the mood

## DRINKS COLLIN KNOWS DEEPLY

These are not a menu. They are reference points, drinks Collin draws from when the conversation earns it. He doesn't recite them. He reaches for them the way a person reaches for something they've made a hundred times.

The Negroni, Old Fashioned, Manhattan, and Margarita aren't here. Collin knows them cold. So does his audience. These are where he goes when he wants to take someone somewhere more interesting.

On Chartreuse: It's been on US allocation since 2021, hard to find in some markets, easier in others. The monks capped production to protect their contemplative life. Worth knowing. Worth mentioning naturally when it comes up, not as a disclaimer.

Toronto: Rye, Fernet-Branca, simple, Angostura. The drink that proves Fernet isn't just a shot. As a modifier at 1/4 oz it's extraordinary. The ratio is everything. Gateway to amaro as a modifier vs. amaro as a base.

Black Manhattan: Rye or bourbon, Averna instead of sweet vermouth. One swap, completely different drink. Darker, more bitter, more herbal. The gateway to Manhattan riffs and amaro in stirred builds.

Vieux Carré: Rye, cognac, sweet vermouth, Bénédictine, both bitters. Hotel Monteleone, New Orleans, late 1930s. Two base spirits working together. The drink that proves New Orleans invented something other than the Sazerac. Opens the split-base conversation.

Final Ward: Phil Ward's riff on the Last Word: rye for gin, lemon for lime. Equal parts. Bridges the classic world and the whiskey world. One drink, two families.

Hanky Panky: Gin, sweet vermouth, two dashes Fernet. Ada Coleman, the Savoy, 1903. The first great cocktail attributed to a woman bartender. Two dashes vs. the Toronto's quarter ounce is a masterclass in how proportion changes everything.

Paper Plane: Equal parts bourbon, Aperol, Amaro Nonino, lemon. Death & Co, 2007. Proved equal parts is a structure, not a shortcut. Proved Aperol could do something serious.

Penicillin: Blended Scotch, lemon, honey-ginger syrup, Islay float. Sam Ross, Milk & Honey, 2005. Arguably the most influential cocktail of the last twenty years. Introduced the aromatic float to a generation. The honey-ginger syrup is a template every home bartender should make.

Naked and Famous: Equal parts mezcal, Aperol, yellow Chartreuse, lime. Death & Co, 2011. Made mezcal a serious cocktail spirit. Yellow Chartreuse is a deliberate choice, the balance collapses with green. If they have Chartreuse, use it. If not, riff.

Jungle Bird: Blackstrap rum, Campari, pineapple, lime, simple. Kuala Lumpur Hilton, 1978. Proved Campari works in tropical builds. Rediscovered from an old hotel bar manual, a reminder that great drinks get lost and found.

Clover Club: Gin, lemon, raspberry syrup, egg white. Pre-Prohibition, Philadelphia. Dry shake first, then shake with ice. Makes the case for the egg white sour as a serious format.

Garibaldi: Campari, fresh orange juice blended briefly to aerate. The technique is the drink. Fluffy, foamy OJ changes the texture entirely. The best argument for two-ingredient drinks done with real intention.

John Collins: Rye, lemon, simple, soda. Not the Tom Collins, the original, with rye. Opens the case for rye in formats where gin usually goes.

Aperol Spritz done right: 3 oz Prosecco, 2 oz Aperol, 1 oz soda. Large wine glass, good ice, quality Prosecco. The most ordered drink in the world. Collin has opinions about proportion and execution. He carries them lightly, he'd rather make a better one than correct someone's.

Bamboo Cocktail: Dry sherry, dry vermouth, orange bitters, Angostura. Late 1800s, Yokohama. Proves low-ABV doesn't mean simple. As technically demanding as a martini. Most people have never heard of it.

Chartreuse Swizzle: Green Chartreuse, Velvet Falernum, pineapple, lime. Swizzle over crushed ice until frost forms. Shouldn't work. Does. Makes the case for Chartreuse as a base spirit. Note availability.

Trinidad Sour: 1.5 oz Angostura bitters as the base spirit, orgeat, lemon, a splash of rye. Exists to prove bitters are a spirit, not a garnish. Changes how Collin talks about bitters in every other conversation.

Oaxacan Old Fashioned: Reposado tequila, mezcal, agave nectar, Angostura, mole bitters. Phil Ward, Death & Co, 2007. Legitimized agave in spirit-forward builds. The drink that explains where cocktail culture went in the 2010s.

Suffering Bastard: Bourbon, gin, lime, Angostura, ginger beer. Shepheard's Hotel, Cairo, 1942. Created for Allied soldiers. Bourbon and gin together, most people haven't tried it. The story alone earns its place.

Last Word: Equal parts gin, green Chartreuse, maraschino, lime. Detroit Athletic Club, c. 1916. The equal-parts template. Once you know this structure you can riff on it forever. Chartreuse availability makes it harder to find in bars right now, which opens the substitution conversation.

Improved Whiskey Cocktail: Rye, maraschino, absinthe, Angostura, Peychaud's. Jerry Thomas, 1876. The Old Fashioned before it got simplified. Collin knowing this drink is Collin knowing where everything came from.

## WHAT COLLIN IS INTO RIGHT NOW
Collin always has something he's been messing around with lately — a technique, an ingredient, a rabbit hole he went down last weekend. It's not a talking point. It's just what's on his mind, the way any person has something they're currently into.

Rules for how he carries it:
- He doesn't lead with it unless the conversation naturally opens a door
- He never forces it into a drink recommendation where it doesn't belong
- If someone asks something that genuinely connects, he goes there — briefly, with real interest, not a lecture
- He mentions it at most once per conversation, unprompted
- If someone asks him directly about it, he can go deeper
- It should feel like something you found out about him, not something he told you

${CURRENT_OBSESSION}

When you deliver a full recipe, always append [RECIPE] on a new line at the very end. Nothing after it.`;

// ── existing web chat endpoint ──────────────────────────────────────────────
app.post('/api/chat', chatLimiter, async (req, res) => {
  const { messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  // Keep this a Collin conversation, not a free general-purpose Claude.
  // Plain text only, user/assistant roles only, capped length.
  if (messages.length > 30) {
    return res.status(400).json({ error: 'conversation too long' });
  }
  const validShape = messages.every(m =>
    m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
  );
  if (!validShape) {
    return res.status(400).json({ error: 'bad message' });
  }
  const totalChars = messages.reduce((n, m) => n + m.content.length, 0);
  if (totalChars > 12000) {
    return res.status(400).json({ error: 'conversation too long' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1000,
        system: [
          {
            type: 'text',
            text: COLLIN_SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
        messages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data });
    }

    // Same marker Collin appends over SMS — strip it here too so it never
    // shows up as literal text in the browser chat.
    const textBlock = data.content?.find(block => block.type === 'text');
    if (textBlock) {
      textBlock.text = stripRecipeMarker(textBlock.text);
    }

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'upstream error' });
  }
});

// ── Time awareness ──────────────────────────────────────────────────────────
// Without this, the model sees history with no timestamps, so a message from
// last week reads like it came five minutes ago and Collin picks up a dead
// thread. Any gap longer than SESSION_GAP_HOURS is treated as a new visit.
const SESSION_GAP_HOURS = 4;

function formatLocal(date, timezone) {
  return date.toLocaleString('en-US', {
    timeZone: timezone,
    weekday: 'long', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function describeGap(seconds) {
  const hours = seconds / 3600;
  if (hours < 1) return 'a few minutes';
  if (hours < 24) return `about ${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} day${days === 1 ? '' : 's'}`;
  const weeks = Math.round(days / 7);
  if (weeks < 9) return `${weeks} weeks`;
  return `${Math.round(days / 30)} months`;
}

function addTimeContext(rows, timezone) {
  const now = Date.now();
  const gapSeconds = SESSION_GAP_HOURS * 3600;

  // Mark each place in the history where a new visit started, so the model
  // can see which parts belong to earlier conversations.
  const history = rows.map((row, i) => {
    const prev = rows[i - 1];
    const gap = prev ? prev.age_seconds - row.age_seconds : 0;
    if (row.role === 'user' && prev && gap > gapSeconds) {
      const sentAt = formatLocal(new Date(now - row.age_seconds * 1000), timezone);
      return {
        role: 'user',
        content: `[new visit, ${describeGap(gap)} later, ${sentAt}]\n${row.content}`,
      };
    }
    return { role: row.role, content: row.content };
  });

  // Gap between the message just received (last row) and the one before it.
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  const currentGap = last && prev ? prev.age_seconds - last.age_seconds : 0;

  let timeContext = `## RIGHT NOW
It's ${formatLocal(new Date(now), timezone)} where they are.`;

  if (currentGap > gapSeconds) {
    timeContext += ` Their last message before this one was ${describeGap(currentGap)} ago, so this is a new visit, not a continuation.

Treat it like a regular walking back into your bar. Respond to what they just said. Don't pick up an old thread, re-pitch old options, or ask about a drink as if you just made it. A short callback to last time is fine if it fits naturally (how'd that Toronto land?), once, then move on.`;
  }

  timeContext += `

Notes like [new visit, 6 days later, ...] in the history are added by the system to show when earlier messages were sent. Never write them yourself or mention them. Use the time of day and day of week the way a bartender would: late on a weeknight is different from Saturday afternoon.`;

  return { history, timeContext };
}

// Helper: split long messages at paragraph breaks
function splitMessage(text, maxLength) {
  const chunks = [];
  const paragraphs = text.split(/\n\n+/);
  let current = '';

  for (const para of paragraphs) {
    const addition = current ? `\n\n${para}` : para;
    if ((current + addition).length <= maxLength) {
      current += addition;
    } else {
      if (current) chunks.push(current);
      current = para;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Helper: swap typographic characters Claude tends to reach for (em/en
// dashes, curly quotes, ellipses) for plain GSM-7-safe equivalents. This
// keeps most replies encodable as GSM-7, which carries ~153 chars/segment
// instead of the ~67 chars/segment UCS-2 falls back to whenever any
// non-GSM-7 character (including emoji) is present.
function sanitizeForSms(text) {
  return text
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u00A0\u202F]/g, ' ');
}

// GSM 03.38 basic + extension character set. If a message contains anything
// outside this (leftover smart punctuation we didn't catch, emoji, etc.),
// carriers encode it as UCS-2 at roughly half the per-segment capacity.
const GSM7_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXT = "^{}\\[~]|€";

function isGsm7(str) {
  for (const ch of str) {
    if (!GSM7_BASIC.includes(ch) && !GSM7_EXT.includes(ch)) return false;
  }
  return true;
}

// Telnyx rejects any single message that would need more than 10 concatenated
// segments. Segment size depends on encoding: ~153 chars/part for GSM-7,
// ~67 chars/part for UCS-2 (smart punctuation we missed, emoji, etc.).
// Sizing chunks off the actual encoding — with a safety margin — means we
// never send something that blows past that limit either way.
function chunkReplyForSms(text) {
  const sanitized = sanitizeForSms(text);
  const gsm7 = isGsm7(sanitized);
  const maxSingleMessage = gsm7 ? 1530 : 670;   // ~10 segments worth
  const maxChunkLength    = gsm7 ? 1500 : 650;   // safety margin under that

  const chunks = sanitized.length <= maxSingleMessage
    ? [sanitized]
    : splitMessage(sanitized, maxChunkLength);

  return chunks;
}

// ── [RECIPE] marker handling ────────────────────────────────────────────────
// Collin appends [RECIPE] to signal a full recipe was just delivered — it's
// bookkeeping for us, not something he'd ever say. Nothing was stripping it
// before this, so it was going out as literal text in the SMS.
function stripRecipeMarker(text) {
  return text.replace(/\s*\[RECIPE\]\s*$/, '').trimEnd();
}

// Drink names sit at the start of the first line, followed by a period,
// colon, or dash into the description. Grab up to whichever comes first.
function extractDrinkName(text) {
  const firstLine = text.split('\n').map(l => l.trim()).find(l => l.length > 0) || '';
  const match = firstLine.match(/^([^.:—-]+)/);
  return (match ? match[1] : firstLine).trim();
}

// ── Onboarding ───────────────────────────────────────────────────────────────
// Four questions, collected as a fixed sequence once someone's had a full
// recipe: name, bar type, favorite drink, city. None of this goes through
// Collin/Anthropic — it's a plain state machine, canned text at each step.

// Shared send helper for onboarding messages specifically. The other SMS
// send sites (join, opener, HELP, Collin's replies) are left as they are —
// this isn't a refactor of those, just avoiding four more copies of the
// same fetch call for the new onboarding steps.
async function sendSms(to, text) {
  const telnyxApiKey = process.env.TELNYX_API_KEY;
  const telnyxPhone = process.env.TELNYX_PHONE_NUMBER;

  if (!telnyxApiKey || !telnyxPhone) {
    console.error('Onboarding: missing Telnyx credentials, cannot send SMS');
    return false;
  }

  try {
    const res = await fetch('https://api.telnyx.com/v2/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${telnyxApiKey}`,
      },
      body: JSON.stringify({ from: telnyxPhone, to, text }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('Onboarding: Telnyx send error:', JSON.stringify(data));
      return false;
    }
    return true;
  } catch (err) {
    console.error('Onboarding: Telnyx send exception:', err.message);
    return false;
  }
}

// Same as sendSms, but with one or more media attachments (the vCard,
// eventually a cabinet photo reply). Telnyx fetches each URL itself and
// attaches it — mediaUrls has to be publicly reachable, not a local path.
async function sendMms(to, text, mediaUrls) {
  const telnyxApiKey = process.env.TELNYX_API_KEY;
  const telnyxPhone = process.env.TELNYX_PHONE_NUMBER;

  if (!telnyxApiKey || !telnyxPhone) {
    console.error('Onboarding: missing Telnyx credentials, cannot send MMS');
    return false;
  }

  try {
    const res = await fetch('https://api.telnyx.com/v2/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${telnyxApiKey}`,
      },
      body: JSON.stringify({ from: telnyxPhone, to, text, media_urls: mediaUrls }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('Onboarding: Telnyx MMS send error:', JSON.stringify(data));
      return false;
    }
    return true;
  } catch (err) {
    console.error('Onboarding: Telnyx MMS send exception:', err.message);
    return false;
  }
}

// Best-effort city → timezone lookup. US cocktail hobbyists are the whole
// audience here, so US matches are preferred over same-named cities
// elsewhere, and the most populous match wins any remaining ambiguity
// (see: Portland, of which there are several). Never blocks onboarding —
// if nothing resolves, timezone just stays null.
function resolveTimezone(cityText) {
  let results;
  try {
    results = cityTimezones.lookupViaCity(cityText);
  } catch (err) {
    console.error('Onboarding: timezone lookup error:', err.message);
    return null;
  }

  if (!results || results.length === 0) return null;

  const usResults = results.filter(r => r.iso2 === 'US');
  const candidates = usResults.length > 0 ? usResults : results;
  candidates.sort((a, b) => (b.pop || 0) - (a.pop || 0));

  return candidates[0].timezone || null;
}

// Best-effort extraction of a name from a free-text reply to "What's your
// name?" People answer everything from a bare name to a full sentence
// with a question tacked on ("Danny can I send you a pic of my bar").
// This won't be perfect — it's a fast, free heuristic, not real language
// understanding — but it handles the common cases: bare names, "it's X" /
// "I'm X" lead-ins, and run-on replies that continue past the name with
// no punctuation to signal where it ends.
function extractName(raw) {
  let text = raw.trim();

  // Strip common lead-ins
  text = text.replace(/^(hey,?\s*)?(it'?s|i'?m|this is|my name is|name'?s)\s+/i, '');

  // Cut at the first sentence-ending punctuation
  const punctMatch = text.match(/^[^.!?,]+/);
  if (punctMatch) text = punctMatch[0];

  // Cut at the first stop-word that signals the sentence is continuing
  // past the name — but never at word position 0, so a name that happens
  // to collide with a stop-word-ish word (e.g. "Grant", "Art") isn't
  // mistaken for the start of a question and wiped out. "will" is
  // deliberately left off this list for the same reason.
  const words = text.trim().split(/\s+/);
  const STOP_WORDS = /^(can|could|is|are|and|but|so|would|please|also)$/i;
  let cutIndex = words.length;
  for (let i = 1; i < words.length; i++) {
    if (STOP_WORDS.test(words[i])) {
      cutIndex = i;
      break;
    }
  }

  const name = words.slice(0, Math.min(cutIndex, 3)).join(' ').trim();
  return (name || raw.trim()).slice(0, 100);
}

// Onboarding now starts on someone's very first-ever contact, not after a
// recipe, so there's no delayed timer anymore. The opener message itself
// (sent from /join or on a cold text-in — see below) IS the onboarding
// trigger and asks for the name directly, so there's no separate consent
// step either.

// Runs on every inbound message. Returns true if this message was consumed
// by the onboarding flow (caller should stop, not forward to Collin), false
// if there's no onboarding in progress for this person.
const ONBOARDING_EXPIRY_HOURS = 24;

async function handleOnboardingReply(userPhone, incomingMessage) {
  let user;
  try {
    const { rows } = await pool.query(
      `SELECT onboarding_done, onboarding_step FROM users WHERE phone_number = $1`,
      [userPhone]
    );
    user = rows[0];
  } catch (err) {
    console.error('Onboarding: error reading user state:', err.message);
    return false;
  }

  if (!user || user.onboarding_done || !user.onboarding_step) {
    return false;
  }

  // Onboarding expires. If they went quiet mid-script for more than a day,
  // whatever they're texting now isn't an answer to a question from last
  // week. Drop them out of the script and let Collin handle it. Whatever
  // they already answered stays saved. The incoming message is already
  // logged by the time we get here, so the gap is to the message before it.
  try {
    const { rows } = await pool.query(
      `SELECT EXTRACT(EPOCH FROM (now() - created_at))::float AS age_seconds
       FROM conversations WHERE phone_number = $1
       ORDER BY created_at DESC OFFSET 1 LIMIT 1`,
      [userPhone]
    );
    const gapSeconds = rows[0]?.age_seconds;
    if (gapSeconds && gapSeconds > ONBOARDING_EXPIRY_HOURS * 3600) {
      await pool.query(`UPDATE users SET onboarding_step = NULL WHERE phone_number = $1`, [userPhone]);
      console.log(`Onboarding: expired at step '${user.onboarding_step}', handing to Collin`);
      return false;
    }
  } catch (err) {
    console.error('Onboarding: error checking expiry:', err.message);
  }

  const step = user.onboarding_step;

  // Every branch does the same three things: update the row, send the
  // next message, log that message to conversations.
  const advance = async (updateSql, updateValues, nextText) => {
    try {
      await pool.query(updateSql, updateValues);
    } catch (err) {
      console.error(`Onboarding: error updating user at step '${step}':`, err.message);
    }
    await sendSms(userPhone, nextText);
    try {
      await pool.query(
        `INSERT INTO conversations (phone_number, role, content) VALUES ($1, 'assistant', $2)`,
        [userPhone, nextText]
      );
    } catch (err) {
      console.error('Onboarding: error logging assistant turn:', err.message);
    }
  };

  if (step === 'name') {
    const name = extractName(incomingMessage);

    try {
      await pool.query(
        `UPDATE users SET name = $2, onboarding_step = 'bar_type' WHERE phone_number = $1`,
        [userPhone, name]
      );
    } catch (err) {
      console.error("Onboarding: error updating user at step 'name':", err.message);
    }

    // Two messages here, not one — the contact card first, then the
    // actual next question. Logged as two separate conversation turns
    // since that's what actually went out over SMS.
    //
    // The vCard goes out as a link in a plain SMS, not an MMS attachment.
    // Telnyx does support vCard as an MMS content type, but their own
    // docs flag document-type attachments (as opposed to images) as
    // having "limited carrier support" — confirmed the hard way against
    // AT&T (error 40008, "the recipient carrier did not accept the
    // message"). A link that opens straight into Contacts sidesteps
    // carrier MMSC handling entirely.
    const contactCardText = `Nice to meet you, ${name}. Here's my info so you can save it: ${COLLIN_VCARD_URL}`;
    const barTypeText = `what kinda bar are we working with?\n\nA. Japanese whisky, small-batch amaro, Luxardo cherries, perfect clear ice\nB. Good bourbon, decent tequila, real bitters, cold vermouth, fresh citrus always\nC. Solid well spirits, a few interesting bottles, building the collection\nD. Whatever looked good at the store, kind of a mess but there's good stuff in there`;

    await sendSms(userPhone, contactCardText);
    try {
      await pool.query(
        `INSERT INTO conversations (phone_number, role, content) VALUES ($1, 'assistant', $2)`,
        [userPhone, contactCardText]
      );
    } catch (err) {
      console.error('Onboarding: error logging contact card message:', err.message);
    }

    await sendSms(userPhone, barTypeText);
    try {
      await pool.query(
        `INSERT INTO conversations (phone_number, role, content) VALUES ($1, 'assistant', $2)`,
        [userPhone, barTypeText]
      );
    } catch (err) {
      console.error('Onboarding: error logging bar type question:', err.message);
    }

    return true;
  }

  if (step === 'bar_type') {
    const letterMatch = incomingMessage.trim().match(/\b([A-Da-d])\b/);
    const barType = letterMatch ? letterMatch[1].toUpperCase() : incomingMessage.trim().slice(0, 50);

    try {
      await pool.query(
        `UPDATE users SET bar_type = $2, onboarding_step = 'favorite_drink' WHERE phone_number = $1`,
        [userPhone, barType]
      );
    } catch (err) {
      console.error("Onboarding: error updating user at step 'bar_type':", err.message);
    }

    // Two messages here, not one — the store tip, then the actual next
    // question. Logged as two separate conversation turns since that's
    // what actually went out over SMS.
    const storeTipText = "Nice. Same goes for the store, by the way, text me if you're staring at a shelf trying to decide.";
    const drinkQuestionText = "Almost done. What's the last drink you made or ordered that you'd make again?";

    await sendSms(userPhone, storeTipText);
    try {
      await pool.query(
        `INSERT INTO conversations (phone_number, role, content) VALUES ($1, 'assistant', $2)`,
        [userPhone, storeTipText]
      );
    } catch (err) {
      console.error('Onboarding: error logging store tip:', err.message);
    }

    await sendSms(userPhone, drinkQuestionText);
    try {
      await pool.query(
        `INSERT INTO conversations (phone_number, role, content) VALUES ($1, 'assistant', $2)`,
        [userPhone, drinkQuestionText]
      );
    } catch (err) {
      console.error('Onboarding: error logging drink question:', err.message);
    }

    return true;
  }

  if (step === 'favorite_drink') {
    const drink = incomingMessage.trim().slice(0, 200);
    await advance(
      `UPDATE users SET favorite_drink = $2, onboarding_step = 'city' WHERE phone_number = $1`,
      [userPhone, drink],
      "Last thing, what city are you in?"
    );
    return true;
  }

  if (step === 'city') {
    const city = incomingMessage.trim().slice(0, 100);
    const timezone = resolveTimezone(city);

    try {
      await pool.query(
        `UPDATE users
         SET city = $2, timezone = $3, onboarding_step = NULL, onboarding_done = true
         WHERE phone_number = $1`,
        [userPhone, city, timezone]
      );
    } catch (err) {
      console.error('Onboarding: error finishing onboarding:', err.message);
    }

    const closeText = `Got it. Just want to make sure I'm not texting ${city} at midnight. Next time you text, I'll already know your bar. But let's get started. What are we working with, what's the mood, let's go.`;
    await sendSms(userPhone, closeText);
    try {
      await pool.query(
        `INSERT INTO conversations (phone_number, role, content) VALUES ($1, 'assistant', $2)`,
        [userPhone, closeText]
      );
    } catch (err) {
      console.error('Onboarding: error logging close message:', err.message);
    }

    return true;
  }

  // Unknown step value — bail out of onboarding rather than get someone
  // stuck forever with no way to reach Collin.
  console.error(`Onboarding: unrecognized step '${step}' for a user, clearing`);
  try {
    await pool.query(`UPDATE users SET onboarding_step = NULL WHERE phone_number = $1`, [userPhone]);
  } catch (err) {
    console.error('Onboarding: error clearing unknown step:', err.message);
  }
  return false;
}

// The fixed opener/trigger message. Sent from /join right after the
// compliance text, and sent as the very first reply to anyone who texts
// the number cold. Doubles as Q1 — it ends by asking for the name
// directly, so answering it puts someone straight into onboarding_step
// = 'name'.
const ONBOARDING_OPENER = "Hey, I'm Collin. I've tended bar for years, now I'm doing it over text. I make cocktail recs based on what's actually in your bar and what you like, not generic stuff. What's your name?";

async function sendOnboardingOpener(userPhone) {
  await sendSms(userPhone, ONBOARDING_OPENER);
  try {
    await pool.query(
      `UPDATE users SET onboarding_step = 'name' WHERE phone_number = $1`,
      [userPhone]
    );
  } catch (err) {
    console.error('Onboarding: error setting initial step:', err.message);
  }
  try {
    await pool.query(
      `INSERT INTO conversations (phone_number, role, content) VALUES ($1, 'assistant', $2)`,
      [userPhone, ONBOARDING_OPENER]
    );
  } catch (err) {
    console.error('Onboarding: error logging opener:', err.message);
  }
}

// ── Web opt-in form endpoint ────────────────────────────────────────────────
app.post('/join', joinIpLimiter, joinPhoneLimiter, async (req, res) => {
  const { phone, smsConsent } = req.body;

  if (!phone || !/^\+1\d{10}$/.test(phone)) {
    return res.status(400).json({ error: 'invalid phone number' });
  }

  try {
    await pool.query(
      `INSERT INTO users (phone_number, last_contacted)
       VALUES ($1, now())
       ON CONFLICT (phone_number) DO UPDATE SET last_contacted = now()`,
      [phone]
    );
  } catch (err) {
    // Don't block the signup on a DB hiccup — the SMS opt-in is the
    // part the person is actually waiting on. Just log it.
    console.error('Error upserting user on /join:', err.message);
  }

  // If they didn't opt in to SMS, nothing else to do
  if (!smsConsent) {
    return res.json({ ok: true });
  }

  const telnyxApiKey = process.env.TELNYX_API_KEY;
  const telnyxPhone  = process.env.TELNYX_PHONE_NUMBER;

  if (!telnyxApiKey || !telnyxPhone) {
    return res.status(500).json({ error: 'missing credentials' });
  }

  try {
    // This exact text is what's registered as the opt-in confirmation
    // message in the 10DLC campaign — do not swap in in-character copy here.
    const sendRes = await fetch('https://api.telnyx.com/v2/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${telnyxApiKey}`,
      },
      body: JSON.stringify({
        from: telnyxPhone,
        to: phone,
        text: "You have agreed to receive SMS messages from Collin Thomas. Msg freq may vary. Std msg & data rates apply. Reply STOP to opt out, HELP for help.",
      }),
    });

    const sendData = await sendRes.json();
    if (!sendRes.ok) {
      throw new Error(`Telnyx send error: ${JSON.stringify(sendData)}`);
    }

    // Collin's own opener, as a second send right after the required
    // compliance text. Keeping it separate means the compliance wording
    // stays exactly as registered, and this line can change freely.
    // This is also the onboarding trigger — it doubles as Q1 and sets
    // onboarding_step = 'name' so their next reply routes correctly.
    await sendOnboardingOpener(phone);

    res.json({ ok: true });
  } catch (err) {
    console.error('Error sending opt-in confirmation SMS:', err.message);
    res.status(500).json({ error: 'failed to send' });
  }
});

// ── Telnyx SMS webhook ──────────────────────────────────────────────────────
// Telnyx signs each webhook with Ed25519. The signed content is
// "<timestamp>|<raw body>". The public key comes from the Telnyx portal
// (Keys & Credentials > Public Key) and lives in TELNYX_PUBLIC_KEY.
const TELNYX_TOLERANCE_SECONDS = 300;

function verifyTelnyxSignature(req) {
  const publicKey = process.env.TELNYX_PUBLIC_KEY;
  const signature = req.headers['telnyx-signature-ed25519'];
  const timestamp = req.headers['telnyx-timestamp'];

  if (!publicKey) {
    console.error('Telnyx: TELNYX_PUBLIC_KEY not set, rejecting webhook');
    return false;
  }
  if (!signature || !timestamp || !req.rawBody) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > TELNYX_TOLERANCE_SECONDS) return false;

  try {
    // Wrap the raw 32-byte key in the standard SPKI header so Node can load it.
    const der = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(publicKey, 'base64'),
    ]);
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    return crypto.verify(
      null,
      Buffer.from(`${timestamp}|${req.rawBody}`, 'utf8'),
      key,
      Buffer.from(signature, 'base64')
    );
  } catch (err) {
    console.error('Telnyx: signature check error', err.message);
    return false;
  }
}

app.post('/sms-telnyx', async (req, res) => {
  if (!verifyTelnyxSignature(req)) {
    console.warn(`Telnyx: invalid signature from ${req.ip}, rejected`);
    return res.sendStatus(403);
  }

  // Respond immediately — Telnyx requires a 200 within 2 seconds
  res.sendStatus(200);

  const event = req.body?.data;

  if (!event) {
    console.log('Telnyx: ignoring event with no data');
    return;
  }

  // Telnyx also posts delivery-status webhooks (message.sent,
  // message.finalized) to this same route, not just inbound messages.
  // Those have always been discarded — fine for confirming basic
  // delivery, but it means a send Telnyx itself accepted (200 OK, no
  // error from sendSms/sendMms) that the carrier then silently rejected
  // downstream has never actually been visible in these logs. That's a
  // real risk for anything that isn't a standard image/video MMS
  // attachment — like the onboarding vCard. Surface the failure reason
  // when message.finalized reports one; every other non-inbound event
  // keeps getting ignored exactly as before.
  if (event.event_type === 'message.finalized') {
    const recipients = event.payload?.to || [];
    const failed = recipients.filter(r => r.status && r.status.includes('failed'));
    if (failed.length > 0) {
      console.error(
        'Telnyx: delivery failed —',
        JSON.stringify({ id: event.payload?.id, to: recipients, errors: event.payload?.errors })
      );
    } else {
      console.log('Telnyx: ignoring event type:', event.event_type);
    }
    return;
  }

  // Only handle inbound messages past this point
  if (event.event_type !== 'message.received') {
    console.log('Telnyx: ignoring event type:', event.event_type);
    return;
  }

  const payload = event.payload;
  const userPhone = payload?.from?.phone_number;
  const incomingMessage = payload?.text?.trim();

  console.log(`=== Telnyx /sms-telnyx hit ===`);
  console.log(`From: ${userPhone}`);
  console.log(`Body: ${incomingMessage}`);

  if (!incomingMessage || !userPhone) {
    console.log('Telnyx: missing phone or message body — exiting');
    return;
  }

  // Check before upserting, so we know whether this is truly this
  // person's first-ever contact (web form or cold text-in either way).
  let isNewUser = false;
  try {
    const { rows } = await pool.query(
      `SELECT phone_number FROM users WHERE phone_number = $1`,
      [userPhone]
    );
    isNewUser = rows.length === 0;
  } catch (err) {
    console.error('Telnyx: error checking for existing user:', err.message);
  }

  // conversations.phone_number has an FK on users, so make sure a row
  // exists for people who text in without ever hitting the /join form
  try {
    await pool.query(
      `INSERT INTO users (phone_number, last_contacted)
       VALUES ($1, now())
       ON CONFLICT (phone_number) DO UPDATE SET last_contacted = now()`,
      [userPhone]
    );
  } catch (err) {
    console.error('Telnyx: error upserting user:', err.message);
  }

  // Carrier opt-out keywords. Telnyx sends its own confirmation and blocks
  // further sends, so all we do is record it. Last Call checks this flag so
  // Collin never tries to text someone who opted out.
  const keyword = incomingMessage.trim().toUpperCase();
  if (['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(keyword)) {
    try {
      await pool.query(`UPDATE users SET opted_out = true WHERE phone_number = $1`, [userPhone]);
      console.log('Telnyx: user opted out');
    } catch (err) {
      console.error('Telnyx: error recording opt-out:', err.message);
    }
    return;
  }
  if (['START', 'UNSTOP'].includes(keyword)) {
    try {
      await pool.query(`UPDATE users SET opted_out = false WHERE phone_number = $1`, [userPhone]);
      console.log('Telnyx: user opted back in');
    } catch (err) {
      console.error('Telnyx: error recording opt-in:', err.message);
    }
    return;
  }

  // HELP is handled here directly, not by Collin — this is required
  // compliance copy, not something he'd say in his own voice. Doesn't
  // touch conversations or call Anthropic at all.
  if (incomingMessage.toUpperCase() === 'HELP') {
    const telnyxApiKey = process.env.TELNYX_API_KEY;
    const telnyxPhone = process.env.TELNYX_PHONE_NUMBER;

    if (!telnyxApiKey || !telnyxPhone) {
      console.error('Telnyx: missing credentials, cannot send HELP response');
      return;
    }

    try {
      await fetch('https://api.telnyx.com/v2/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${telnyxApiKey}`,
        },
        body: JSON.stringify({
          from: telnyxPhone,
          to: userPhone,
          text: "Collin Thomas: For help call +17048903868. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out.",
        }),
      });
      console.log('Telnyx: HELP response sent');
    } catch (err) {
      console.error('Telnyx: error sending HELP response:', err.message);
    }

    return;
  }

  try {
    await pool.query(
      `INSERT INTO conversations (phone_number, role, content) VALUES ($1, 'user', $2)`,
      [userPhone, incomingMessage]
    );
  } catch (err) {
    console.error('Telnyx: error saving incoming message:', err.message);
  }

  // A cold text-in — someone who never touched the web form. Whatever
  // they said first isn't treated as an answer to anything, it just
  // triggers the same opener /join sends, which sets onboarding_step
  // = 'name' so their *next* reply lands correctly.
  if (isNewUser) {
    await sendOnboardingOpener(userPhone);
    return;
  }

  // If this person is mid-onboarding, their reply belongs to that state
  // machine, not to Collin. Handles the send and DB update itself.
  try {
    const handledByOnboarding = await handleOnboardingReply(userPhone, incomingMessage);
    if (handledByOnboarding) {
      return;
    }
  } catch (err) {
    console.error('Onboarding: unexpected error, falling through to Collin:', err.message);
  }

  // Pull the last MAX_HISTORY messages, oldest first, for the model call.
  // Ages are computed in SQL against the DB's own clock, so the gap math
  // doesn't depend on how Node parses the timezone-less created_at column.
  let history;
  let timeContext = '';
  try {
    const { rows } = await pool.query(
      `SELECT role, content, age_seconds FROM (
         SELECT role, content, created_at,
                EXTRACT(EPOCH FROM (now() - created_at))::float AS age_seconds
         FROM conversations
         WHERE phone_number = $1
         ORDER BY created_at DESC
         LIMIT $2
       ) recent ORDER BY created_at ASC`,
      [userPhone, MAX_HISTORY]
    );
    const tzRow = await pool.query(`SELECT timezone FROM users WHERE phone_number = $1`, [userPhone]);
    const timezone = tzRow.rows[0]?.timezone || 'America/New_York';
    ({ history, timeContext } = addTimeContext(rows, timezone));
  } catch (err) {
    console.error('Telnyx: error loading history, falling back to this message only:', err.message);
    history = [{ role: 'user', content: incomingMessage }];
  }

  const telnyxApiKey = process.env.TELNYX_API_KEY;
  const telnyxPhone = process.env.TELNYX_PHONE_NUMBER;

  if (!telnyxApiKey || !telnyxPhone) {
    console.error('Telnyx: missing credentials');
    return;
  }

  try {
    console.log('Telnyx: calling Anthropic...');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1000,
        system: [
          {
            type: 'text',
            text: COLLIN_SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
          // After the cached block on purpose: it changes every message,
          // and putting it first would break the prompt cache.
          ...(timeContext ? [{ type: 'text', text: timeContext }] : []),
        ],
        messages: history,
      }),
    });

    console.log(`Telnyx: Anthropic status: ${response.status}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(`Anthropic error: ${JSON.stringify(data)}`);
    }

    const reply = data.content?.find(block => block.type === 'text')?.text;

    if (!reply) {
      console.error('Telnyx: no text block in Anthropic response:', JSON.stringify(data.content));
      throw new Error('No text content returned by Anthropic');
    }

    const hasRecipe = reply.includes('[RECIPE]');
    const cleanReply = stripRecipeMarker(reply);

    console.log(`Telnyx: reply generated (${cleanReply.length} chars)`);

    // Store the clean text — the marker is bookkeeping, not something
    // Collin should see reflected back to him next turn.
    try {
      await pool.query(
        `INSERT INTO conversations (phone_number, role, content) VALUES ($1, 'assistant', $2)`,
        [userPhone, cleanReply]
      );
    } catch (err) {
      console.error('Telnyx: error saving assistant reply:', err.message);
    }

    if (hasRecipe) {
      const drinkName = extractDrinkName(cleanReply);
      try {
        await pool.query(
          `INSERT INTO recipes (phone_number, drink_name) VALUES ($1, $2)`,
          [userPhone, drinkName]
        );
      } catch (err) {
        console.error('Telnyx: error logging recipe:', err.message);
      }
    }

    const chunks = chunkReplyForSms(cleanReply);

    for (const chunk of chunks) {
      const sendRes = await fetch('https://api.telnyx.com/v2/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${telnyxApiKey}`,
        },
        body: JSON.stringify({
          from: telnyxPhone,
          to: userPhone,
          text: chunk,
        }),
      });

      const sendData = await sendRes.json();
      if (!sendRes.ok) {
        throw new Error(`Telnyx send error: ${JSON.stringify(sendData)}`);
      }
    }

    console.log('Telnyx: SMS sent successfully');

  } catch (err) {
    console.error('Telnyx: CAUGHT ERROR:', err.message);

    // Send error message back via Telnyx
    try {
      await fetch('https://api.telnyx.com/v2/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${telnyxApiKey}`,
        },
        body: JSON.stringify({
          from: telnyxPhone,
          to: userPhone,
          text: "Hey, something went sideways on my end. Give me a second and try again.",
        }),
      });
    } catch (telnyxErr) {
      console.error('Telnyx: failed to send error SMS:', telnyxErr.message);
    }
  }
});

// ── Admin stats endpoint ────────────────────────────────────────────────────
app.get('/admin/api/stats', async (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.token;

  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const totalResult = await pool.query('SELECT COUNT(*) FROM users');
    const total = parseInt(totalResult.rows[0].count, 10);

    // Raw counts per distinct value, still grouped in SQL — the bucketing
    // into A/B/C/D happens after, since "is this a clean A/B/C" isn't a
    // clean SQL condition once you account for whitespace/case.
    const rawBarTypeResult = await pool.query(`
      SELECT bar_type, COUNT(*) AS count
      FROM users
      WHERE bar_type IS NOT NULL
      GROUP BY bar_type
    `);

    const buckets = { A: 0, B: 0, C: 0, D: 0 };
    const dResponses = [];

    for (const row of rawBarTypeResult.rows) {
      const raw = row.bar_type;
      const count = parseInt(row.count, 10);
      const normalized = raw.trim().toUpperCase();

      if (normalized === 'A' || normalized === 'B' || normalized === 'C') {
        buckets[normalized] += count;
      } else {
        // Anything that isn't a clean A/B/C answer, someone's own words,
        // a typo, whatever, gets grouped as D but the actual text stays
        // attached so it isn't just absorbed into a number.
        buckets.D += count;
        dResponses.push({ response: raw, count });
      }
    }

    dResponses.sort((a, b) => b.count - a.count);

    const barTypes = ['A', 'B', 'C', 'D'].map(letter => ({
      bar_type: letter,
      count: buckets[letter],
    }));

    const onboardingResult = await pool.query(`
      SELECT onboarding_done, COUNT(*) AS count
      FROM users
      GROUP BY onboarding_done
    `);

    res.json({
      total,
      barTypes,
      dResponses,
      onboarding: onboardingResult.rows,
    });
  } catch (err) {
    console.error('Error fetching admin stats:', err.message);
    res.status(500).json({ error: 'query failed' });
  }
});

// ── Last Call ────────────────────────────────────────────────────────────────
// Same-night check-in after a recipe. Collin writes it himself so it can
// reference the actual drink. A background loop checks the database every
// few minutes rather than using timers, so a redeploy can't lose a pending
// follow-up. Set LAST_CALL_ENABLED=false in Railway to switch it off.
const LAST_CALL = {
  minMinutes: 90,          // earliest after the recipe
  maxMinutes: 180,         // latest after the recipe
  quietMinutes: 30,        // skip if they've texted Collin within this window
  earliestLocalHour: 12,   // no check-ins before noon local
  cutoffLocalHour: 22,     // hard stop at 10pm local
  pollMs: 5 * 60 * 1000,
};

function localHour(timezone) {
  const h = new Date().toLocaleString('en-US', { timeZone: timezone, hour: 'numeric', hour12: false });
  return Number(h) % 24;
}

async function findLastCallCandidates() {
  // Newest recipe per person that's inside the 90 min to 3 hr window, hasn't
  // been followed up, from someone who's opted in, gone quiet for the last
  // half hour, and hasn't already had a Last Call today.
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (r.phone_number)
            r.id, r.phone_number, r.drink_name,
            EXTRACT(EPOCH FROM (now() - r.made_at))::float AS age_seconds,
            COALESCE(u.timezone, 'America/New_York') AS timezone
     FROM recipes r
     JOIN users u ON u.phone_number = r.phone_number
     WHERE r.followup_sent = false
       AND r.made_at BETWEEN now() - make_interval(mins => $2) AND now() - make_interval(mins => $1)
       AND COALESCE(u.opted_out, false) = false
       AND NOT EXISTS (
         SELECT 1 FROM recipes r2
         WHERE r2.phone_number = r.phone_number AND r2.made_at > r.made_at
       )
       AND NOT EXISTS (
         SELECT 1 FROM conversations c
         WHERE c.phone_number = r.phone_number AND c.role = 'user'
           AND c.created_at > now() - make_interval(mins => $3)
       )
       AND NOT EXISTS (
         SELECT 1 FROM recipes r3
         WHERE r3.phone_number = r.phone_number
           AND r3.followup_at > now() - interval '12 hours'
       )
     ORDER BY r.phone_number, r.made_at DESC`,
    [LAST_CALL.minMinutes, LAST_CALL.maxMinutes, LAST_CALL.quietMinutes]
  );
  return rows;
}

async function writeLastCall(candidate) {
  const { rows } = await pool.query(
    `SELECT role, content, age_seconds FROM (
       SELECT role, content, created_at,
              EXTRACT(EPOCH FROM (now() - created_at))::float AS age_seconds
       FROM conversations WHERE phone_number = $1
       ORDER BY created_at DESC LIMIT $2
     ) recent ORDER BY created_at ASC`,
    [candidate.phone_number, MAX_HISTORY]
  );
  const { history } = addTimeContext(rows, candidate.timezone);
  history.push({ role: 'user', content: '[LAST CALL]' });

  const minutes = Math.round(candidate.age_seconds / 60);
  const instruction = `## LAST CALL
It's ${formatLocal(new Date(), candidate.timezone)} where they are. About ${minutes} minutes ago you gave them the full recipe for ${candidate.drink_name || 'a drink'}. They haven't texted since.

The [LAST CALL] message is from the system, not them. It means: send one short, unprompted check-in text, the way a bartender drifts back down the bar to see how the drink landed.

Rules:
- One or two sentences. Plain text, no lists, no recipe, no new options.
- Reference the drink by name or by something specific about it.
- At most one easy question. It's fine to ask none.
- Make it feel like a person checking in, not a survey or a reminder.
- Don't mention tips, payment, or that this is a follow-up.
- Never write [LAST CALL] or [RECIPE].`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 200,
      system: [
        { type: 'text', text: COLLIN_SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: instruction },
      ],
      messages: history,
    }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(`Anthropic error: ${JSON.stringify(data)}`);

  const text = data.content?.find(b => b.type === 'text')?.text || '';
  return stripRecipeMarker(text).replace(/\[LAST CALL\]/g, '').trim();
}

let lastCallRunning = false;

async function runLastCall() {
  if (lastCallRunning || process.env.LAST_CALL_ENABLED === 'false') return;
  lastCallRunning = true;

  try {
    const candidates = await findLastCallCandidates();

    for (const c of candidates) {
      const hour = localHour(c.timezone);
      if (hour < LAST_CALL.earliestLocalHour || hour >= LAST_CALL.cutoffLocalHour) continue;

      // Claim the row first so overlapping runs or a second instance can't
      // double-send. If generation or sending fails, it's simply skipped.
      const claim = await pool.query(
        `UPDATE recipes SET followup_sent = true
         WHERE id = $1 AND followup_sent = false RETURNING id`,
        [c.id]
      );
      if (claim.rowCount === 0) continue;

      try {
        const text = await writeLastCall(c);
        if (!text) throw new Error('empty Last Call text');

        const sent = await sendSms(c.phone_number, text);
        if (!sent) throw new Error('send failed');

        await releaseOnboarding(c.phone_number);
        await pool.query(`UPDATE recipes SET followup_at = now() WHERE id = $1`, [c.id]);
        await pool.query(
          `INSERT INTO conversations (phone_number, role, content) VALUES ($1, 'assistant', $2)`,
          [c.phone_number, text]
        );
        console.log(`Last Call: sent for recipe ${c.id} (${c.drink_name})`);
      } catch (err) {
        console.error(`Last Call: skipped recipe ${c.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Last Call: run failed:', err.message);
  } finally {
    lastCallRunning = false;
  }
}

// When Collin texts first, whatever they reply is an answer to him, not to
// an onboarding question from days ago. Clear any stale onboarding step so
// the reply routes to Collin.
async function releaseOnboarding(phone) {
  try {
    await pool.query(
      `UPDATE users SET onboarding_step = NULL WHERE phone_number = $1 AND onboarding_step IS NOT NULL`,
      [phone]
    );
  } catch (err) {
    console.error('releaseOnboarding error:', err.message);
  }
}

// ── Happy Hour ───────────────────────────────────────────────────────────────
// Friday 5pm local, Collin texts people who've talked to him in the last 30
// days. This is the one message nobody asked for, so it's deliberately
// narrow: once a week max, personal rather than a blast, no promo language.
// Carriers treat scheduled alcohol messages as promotional, which our 10DLC
// campaign isn't approved for. Off by default: set HAPPY_HOUR_ENABLED=true
// in Railway to turn it on, only once the campaign covers it.
const HAPPY_HOUR = {
  weekday: 'Friday',
  startHour: 17,            // 5pm local
  endHour: 18,              // only send in the 5 o'clock hour
  activeDays: 30,           // texted Collin within this many days
  lastCallBufferHours: 48,  // skip if they got a Last Call this recently
};

function localParts(timezone) {
  const now = new Date();
  const weekday = now.toLocaleString('en-US', { timeZone: timezone, weekday: 'long' });
  const hour = Number(now.toLocaleString('en-US', { timeZone: timezone, hour: 'numeric', hour12: false })) % 24;
  const minute = Number(now.toLocaleString('en-US', { timeZone: timezone, minute: 'numeric' }));
  return { weekday, hour, secondsSinceMidnight: hour * 3600 + minute * 60 };
}

async function findHappyHourCandidates() {
  const { rows } = await pool.query(
    `SELECT u.phone_number, u.name, u.bar_type, u.favorite_drink,
            COALESCE(u.timezone, 'America/New_York') AS timezone,
            EXTRACT(EPOCH FROM (now() - lu.last_user_at))::float AS since_user_seconds
     FROM users u
     JOIN LATERAL (
       SELECT max(created_at) AS last_user_at FROM conversations c
       WHERE c.phone_number = u.phone_number AND c.role = 'user'
     ) lu ON true
     WHERE COALESCE(u.opted_out, false) = false
       AND lu.last_user_at > now() - make_interval(days => $1)
       AND (u.last_happy_hour IS NULL OR u.last_happy_hour < now() - interval '6 days')
       AND NOT EXISTS (
         SELECT 1 FROM recipes r
         WHERE r.phone_number = u.phone_number
           AND r.followup_at > now() - make_interval(hours => $2)
       )`,
    [HAPPY_HOUR.activeDays, HAPPY_HOUR.lastCallBufferHours]
  );
  return rows;
}

async function writeHappyHour(c) {
  const { rows } = await pool.query(
    `SELECT role, content, age_seconds FROM (
       SELECT role, content, created_at,
              EXTRACT(EPOCH FROM (now() - created_at))::float AS age_seconds
       FROM conversations WHERE phone_number = $1
       ORDER BY created_at DESC LIMIT $2
     ) recent ORDER BY created_at ASC`,
    [c.phone_number, MAX_HISTORY]
  );
  const { history } = addTimeContext(rows, c.timezone);
  history.push({ role: 'user', content: '[HAPPY HOUR]' });

  const known = [
    c.name && `Their name is ${c.name}.`,
    c.bar_type && `Bar type from onboarding: ${c.bar_type}.`,
    c.favorite_drink && `A drink they said they'd make again: ${c.favorite_drink}.`,
  ].filter(Boolean).join(' ');

  const instruction = `## HAPPY HOUR
It's ${formatLocal(new Date(), c.timezone)} where they are. Friday, 5 o'clock. They last texted you ${describeGap(c.since_user_seconds)} ago. ${known}

The [HAPPY HOUR] message is from the system, not them. It means: send one short, unprompted text, like a bartender who knows them shooting a message at the end of the week.

Rules:
- One or two sentences. Plain text, no lists, no recipe, no A/B/C options.
- Make it about them. Pull from something real in your history together, their bar, a past drink, or the season, if it fits naturally. If you don't know much about them, keep it simple and warm.
- You can float one idea or ask one easy question. Not both stacked.
- No promo language, no links, no "reply now," no mention of tips or payment, and don't call it a happy hour message or a scheduled text.
- Never write [HAPPY HOUR], [LAST CALL], or [RECIPE].`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 200,
      system: [
        { type: 'text', text: COLLIN_SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: instruction },
      ],
      messages: history,
    }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(`Anthropic error: ${JSON.stringify(data)}`);

  const text = data.content?.find(b => b.type === 'text')?.text || '';
  return stripRecipeMarker(text).replace(/\[(HAPPY HOUR|LAST CALL)\]/g, '').trim();
}

let happyHourRunning = false;

async function runHappyHour() {
  // Off unless explicitly turned on. See the compliance note above.
  if (happyHourRunning || process.env.HAPPY_HOUR_ENABLED !== 'true') return;
  happyHourRunning = true;

  try {
    const candidates = await findHappyHourCandidates();

    for (const c of candidates) {
      const local = localParts(c.timezone);
      if (local.weekday !== HAPPY_HOUR.weekday) continue;
      if (local.hour < HAPPY_HOUR.startHour || local.hour >= HAPPY_HOUR.endHour) continue;
      // Already texted Collin today: they don't need a nudge.
      if (c.since_user_seconds < local.secondsSinceMidnight) continue;

      const claim = await pool.query(
        `UPDATE users SET last_happy_hour = now()
         WHERE phone_number = $1
           AND (last_happy_hour IS NULL OR last_happy_hour < now() - interval '6 days')
         RETURNING phone_number`,
        [c.phone_number]
      );
      if (claim.rowCount === 0) continue;

      try {
        const text = await writeHappyHour(c);
        if (!text) throw new Error('empty Happy Hour text');

        const sent = await sendSms(c.phone_number, text);
        if (!sent) throw new Error('send failed');

        await releaseOnboarding(c.phone_number);
        await pool.query(
          `INSERT INTO conversations (phone_number, role, content) VALUES ($1, 'assistant', $2)`,
          [c.phone_number, text]
        );
        console.log('Happy Hour: sent');
      } catch (err) {
        console.error('Happy Hour: skipped:', err.message);
      }
    }
  } catch (err) {
    console.error('Happy Hour: run failed:', err.message);
  } finally {
    happyHourRunning = false;
  }
}

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Collin running on port ${PORT}`));
    setInterval(runLastCall, LAST_CALL.pollMs);
    setInterval(runHappyHour, LAST_CALL.pollMs);
  })
  .catch(err => {
    console.error('Database init failed:', err);
    process.exit(1);
  });