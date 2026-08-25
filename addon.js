// Addon Stremio/Nuvio — Catalogue des dernières sorties FR
// - Films : sortis en digital ou Blu-ray en France (exclut salles-only / production)
// - Séries : saisons terminées et disponibles sur au moins une plateforme de streaming en France
//
// Nécessite une clé API TMDB (gratuite) : https://www.themoviedb.org/settings/api

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const fetch = require('node-fetch');

const TMDB_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE = 'https://api.themoviedb.org/3';

// Fenêtre de "récence" en jours pour considérer une sortie comme "dernière sortie"
const WINDOW_DAYS_MOVIES = 60;
const WINDOW_DAYS_SERIES = 45;

// Exclusions
const EXCLUDED_MOVIE_GENRES = [99]; // Documentaire uniquement (les biopics musicaux restent inclus) — films uniquement
const EXCLUDED_ORIGIN_COUNTRIES = ['IN']; // Inde — films et séries

if (!TMDB_KEY) {
  console.warn('[ATTENTION] Variable TMDB_API_KEY manquante. Définis-la avant de lancer le serveur.');
}

const manifest = {
  id: 'org.custom.fr.digital.releases',
  version: '1.0.0',
  name: 'Sorties FR — Digital / Blu-ray',
  description: 'Derniers films sortis en France en digital ou Blu-ray, et dernières saisons de séries disponibles en streaming en France.',
  resources: ['catalog', 'meta'],
  types: ['movie', 'series'],
  catalogs: [
    {
      type: 'movie',
      id: 'fr-digital-bluray-movies',
      name: 'Films — Sorties Digital/Blu-ray FR',
      extra: [{ name: 'skip', isRequired: false }]
    },
    {
      type: 'series',
      id: 'fr-digital-series',
      name: 'Séries — Nouvelles saisons dispo FR',
      extra: [{ name: 'skip', isRequired: false }]
    }
  ],
  idPrefixes: ['tmdb:']
};

const builder = new addonBuilder(manifest);

// ---------- Helpers ----------

function daysSince(dateStr) {
  return (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24);
}

function isV4Token(key) {
  // Le jeton v4 (Read Access Token) est un JWT : plusieurs segments séparés par des points, assez long.
  return key.includes('.') && key.length > 100;
}

async function tmdbGet(path, params = {}) {
  let url, options;
  if (isV4Token(TMDB_KEY)) {
    const qs = new URLSearchParams({ language: 'fr-FR', ...params });
    url = `${TMDB_BASE}${path}?${qs.toString()}`;
    options = { headers: { Authorization: `Bearer ${TMDB_KEY}`, accept: 'application/json' } };
  } else {
    const qs = new URLSearchParams({ api_key: TMDB_KEY, language: 'fr-FR', ...params });
    url = `${TMDB_BASE}${path}?${qs.toString()}`;
    options = {};
  }
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`TMDB ${path} -> ${res.status}`);
  return res.json();
}

// ---------- FILMS ----------
// Types TMDB release_dates : 1=Premiere 2=Théâtral limité 3=Théâtral 4=Digital 5=Physique(Blu-ray/DVD) 6=TV

async function fetchCandidateMovies(page) {
  const data = await tmdbGet('/discover/movie', {
    region: 'FR',
    sort_by: 'primary_release_date.desc',
    page,
    include_adult: 'false',
    without_genres: EXCLUDED_MOVIE_GENRES.join(','),
    'primary_release_date.lte': new Date().toISOString().slice(0, 10)
  });
  return data.results || [];
}

async function getFrMovieDetails(movieId) {
  // Appel combiné : détails + dates de sortie FR + mots-clés (pour détecter les films-concerts)
  return tmdbGet(`/movie/${movieId}`, { append_to_response: 'release_dates,keywords' });
}

function isConcertFilm(movieDetails) {
  const keywords = movieDetails.keywords?.keywords || [];
  return keywords.some(k => k.name && k.name.toLowerCase().includes('concert'));
}

function extractFrReleaseInfo(movieDetails) {
  const frEntry = (movieDetails.release_dates?.results || []).find(r => r.iso_3166_1 === 'FR');
  if (!frEntry) return null;
  const digitalOrPhysical = frEntry.release_dates.filter(rd => rd.type === 4 || rd.type === 5);
  if (digitalOrPhysical.length === 0) return null;
  digitalOrPhysical.sort((a, b) => new Date(b.release_date) - new Date(a.release_date));
  return digitalOrPhysical[0]; // la plus récente
}

async function buildMovieCatalog(skip) {
  const page = Math.floor(skip / 20) + 1;
  const candidates = await fetchCandidateMovies(page);
  const metas = [];

  for (const movie of candidates) {
    const details = await getFrMovieDetails(movie.id);

    const countries = (details.production_countries || []).map(c => c.iso_3166_1);
    if (countries.some(c => EXCLUDED_ORIGIN_COUNTRIES.includes(c))) continue;

    const genreIds = (details.genres || []).map(g => g.id);
    if (genreIds.some(g => EXCLUDED_MOVIE_GENRES.includes(g))) continue;

    if (isConcertFilm(details)) continue;

    const releaseInfo = extractFrReleaseInfo(details);
    if (!releaseInfo) continue; // pas encore de sortie digitale/physique en FR

    const age = daysSince(releaseInfo.release_date);
    if (age < 0 || age > WINDOW_DAYS_MOVIES) continue;

    metas.push({
      id: `tmdb:movie:${movie.id}`,
      type: 'movie',
      name: movie.title,
      poster: movie.poster_path ? `https://image.tmdb.org/t/p/w342${movie.poster_path}` : null,
      releaseInfo: releaseInfo.release_date.slice(0, 10),
      description: movie.overview
    });
  }
  return metas;
}

// ---------- SÉRIES ----------
// TMDB n'a pas de "release_dates" digital/physique pour les séries.
// Approche : dernier épisode diffusé récemment (saison terminée = dispo intégralement)
// + vérification qu'au moins un fournisseur de streaming existe en FR (watch/providers).

async function fetchCandidateSeries(page) {
  const data = await tmdbGet('/discover/tv', {
    sort_by: 'first_air_date.desc',
    page,
    watch_region: 'FR',
    with_watch_monetization_types: 'flatrate|rent|buy'
  });
  return data.results || [];
}

async function getFrSeriesAvailability(seriesId) {
  const data = await tmdbGet(`/tv/${seriesId}/watch/providers`, {});
  const fr = data.results && data.results.FR;
  if (!fr) return false;
  return Boolean(fr.flatrate || fr.rent || fr.buy);
}

async function buildSeriesCatalog(skip) {
  const page = Math.floor(skip / 20) + 1;
  const candidates = await fetchCandidateSeries(page);
  const metas = [];

  for (const show of candidates) {
    if (!show.last_air_date) continue;
    if ((show.origin_country || []).some(c => EXCLUDED_ORIGIN_COUNTRIES.includes(c))) continue;
    const age = daysSince(show.last_air_date);
    if (age < 0 || age > WINDOW_DAYS_SERIES) continue;

    const available = await getFrSeriesAvailability(show.id);
    if (!available) continue; // pas encore dispo en streaming en France

    metas.push({
      id: `tmdb:series:${show.id}`,
      type: 'series',
      name: show.name,
      poster: show.poster_path ? `https://image.tmdb.org/t/p/w342${show.poster_path}` : null,
      releaseInfo: show.last_air_date.slice(0, 10),
      description: show.overview
    });
  }
  return metas;
}

// ---------- Handlers ----------

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const skip = extra && extra.skip ? parseInt(extra.skip, 10) : 0;

  if (type === 'movie' && id === 'fr-digital-bluray-movies') {
    return { metas: await buildMovieCatalog(skip) };
  }
  if (type === 'series' && id === 'fr-digital-series') {
    return { metas: await buildSeriesCatalog(skip) };
  }
  return { metas: [] };
});

builder.defineMetaHandler(async ({ type, id }) => {
  const tmdbId = id.split(':')[2];

  if (type === 'movie') {
    const movie = await tmdbGet(`/movie/${tmdbId}`, {});
    return {
      meta: {
        id,
        type: 'movie',
        name: movie.title,
        poster: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null,
        background: movie.backdrop_path ? `https://image.tmdb.org/t/p/original${movie.backdrop_path}` : null,
        description: movie.overview,
        releaseInfo: movie.release_date,
        genres: (movie.genres || []).map(g => g.name)
      }
    };
  }

  if (type === 'series') {
    const show = await tmdbGet(`/tv/${tmdbId}`, {});
    return {
      meta: {
        id,
        type: 'series',
        name: show.name,
        poster: show.poster_path ? `https://image.tmdb.org/t/p/w500${show.poster_path}` : null,
        background: show.backdrop_path ? `https://image.tmdb.org/t/p/original${show.backdrop_path}` : null,
        description: show.overview,
        releaseInfo: show.last_air_date,
        genres: (show.genres || []).map(g => g.name)
      }
    };
  }

  return { meta: null };
});

// ---------- Lancement du serveur ----------

const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`Addon lancé sur http://localhost:${PORT}/manifest.json`);
