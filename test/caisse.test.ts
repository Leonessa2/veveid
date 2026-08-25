// ⚠️ DEPOT : VeVePreda/veveid   ·   CHEMIN : test/caisse.test.ts   (FICHIER NEUF — lot 198)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Server } from 'node:http';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 LOT 198 — LA PORTE DE LA CAISSE, JOUÉE PAR HTTP
 * ═══════════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ PAR HTTP, ET PAS SUR LES FONCTIONS — même raison qu'`admin.test.ts` :
 * ce qu'il faut garder n'est pas seulement ce que `honorerPaiement()` calcule,
 * c'est QUI a le droit de l'appeler. Une route posée au mauvais endroit du
 * fichier, ou gardée par le mauvais secret, se voit ici et nulle part ailleurs.
 *
 * ⛔ ET LE CONTRÔLE LE PLUS IMPORTANT DE CE FICHIER EST LE PLUS COURT : le
 * secret des JEUX ne doit PAS ouvrir cette porte. Sans lui, tout le reste
 * prouverait que la caisse fonctionne — jamais qu'elle est fermée.
 */

const dossier = mkdtempSync(join(tmpdir(), 'veveid-caisse-'));
const SERVICE = 'secret-de-service-des-jeux-0001';
const CAISSE = 'secret-de-caisse-du-site-000002';
const W = '0x' + 'cd'.repeat(20);

let serveur: Server;
let racine = '';

before(async () => {
  const f = join(dossier, 'caisse.db');
  const db = new DatabaseSync(f);
  // ⭐ Une base « d'avant », sans `site` ni `palier` ni `paiements` : la
  //   migration doit les poser, et c'est ce que le premier test vérifie.
  db.exec(`CREATE TABLE comptes (
    id TEXT PRIMARY KEY, wallet TEXT, email TEXT, verifie INTEGER NOT NULL DEFAULT 0,
    verifie_le TEXT, cree_le TEXT NOT NULL, abonne_jusqu_a TEXT, supprime_le TEXT);`);
  db.prepare('INSERT INTO comptes (id, wallet, email, verifie, cree_le) VALUES (?,?,?,?,?)')
    .run('acheteur', W, 'acheteur@exemple.net', 1, '2026-08-01T00:00:00.000Z');
  db.close();

  process.env.DB_PATH = f;
  process.env.SITE_DEFAUT = 'veveprice';
  process.env.SESSION_SECRET = 'secret-de-banc-0123456789abcdef';
  process.env.ID_SERVICE = SERVICE;
  process.env.ID_CAISSE = CAISSE;
  process.env.JEUX = 'veveprice=https://veveprice.com';
  process.env.URL_PUBLIQUE = 'https://id.exemple.net';

  const s = await import('../server.ts');
  serveur = s.serveur;
  await new Promise<void>((r) => serveur.listen(0, '127.0.0.1', r));
  const a = serveur.address() as { port: number };
  racine = `http://127.0.0.1:${a.port}`;
});

after(async () => {
  await new Promise<void>((r) => serveur.close(() => r()));
  const m = await import('../src/db.ts');
  (m as any).fermer?.();
  rmSync(dossier, { recursive: true, force: true });
});

const payer = (corps: unknown, entetes: Record<string, string> = {}) =>
  fetch(`${racine}/api/abonner`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service': SERVICE, 'x-caisse': CAISSE, ...entetes },
    body: JSON.stringify(corps),
  });

test('⭐ un paiement accorde le palier acheté', async () => {
  const av = await import('../src/avoirs.ts');
  assert.equal(av.paliDe(av.lireCompte('acheteur')), 'member', 'avant : membre simple');

  const r = await payer({ reference: 'pay-0001', compte: 'acheteur', jours: 30, palier: 'whale' });
  assert.equal(r.status, 200);
  const j = await r.json() as any;
  assert.equal(j.ok, true);
  assert.equal(j.rejeu, false);
  assert.equal(av.paliDe(av.lireCompte('acheteur')), 'whale', 'après : le palier payé');
});

/**
 * ⭐⭐⭐ LE CONTRÔLE POUR LEQUEL CE FICHIER EXISTE. Un prestataire de paiement
 * REJOUE ses notifications quand il n'a pas reçu de réponse — c'est sa
 * garantie de fiabilité, pas un défaut. Sans garde, un simple incident réseau
 * offre six mois à quelqu'un qui a payé un mois, et rien ne le signale.
 */
test('⛔ le MÊME paiement rejoué n’accorde RIEN de plus', async () => {
  const av = await import('../src/avoirs.ts');
  const avant = av.lireCompte('acheteur')!.abonne_jusqu_a;

  for (let n = 0; n < 3; n++) {
    const r = await payer({ reference: 'pay-0001', compte: 'acheteur', jours: 30, palier: 'whale' });
    const j = await r.json() as any;
    assert.equal(r.status, 200, 'un rejeu répond 200 — une erreur ferait RÉESSAYER le prestataire');
    assert.equal(j.rejeu, true, 'et il se déclare rejeu');
  }
  assert.equal(av.lireCompte('acheteur')!.abonne_jusqu_a, avant,
    '⛔ trois rejeux ne doivent pas ajouter un seul jour');
});

test('⭐ une référence NEUVE, elle, prolonge bien', async () => {
  const av = await import('../src/avoirs.ts');
  const avant = av.lireCompte('acheteur')!.abonne_jusqu_a!;
  const r = await payer({ reference: 'pay-0002', compte: 'acheteur', jours: 30, palier: 'whale' });
  assert.equal(((await r.json()) as any).rejeu, false);
  assert.ok(av.lireCompte('acheteur')!.abonne_jusqu_a! > avant,
    '⛔ sinon la garde anti-rejeu bloquerait aussi les vrais renouvellements');
});

/**
 * ⛔⛔ LE TÉMOIN NON DÉSARMÉ, ET C'EST LE PLUS IMPORTANT DU FICHIER.
 * Le bloc `/api/` est gardé par `ID_SERVICE`, un secret PARTAGÉ AVEC LES JEUX
 * (le A_LIRE du dépôt : « le MÊME secret de service »). Si cette route se
 * contentait de cette garde, chaque jeu pourrait s'accorder des abonnements.
 */
test('⛔ le secret des JEUX seul n’ouvre PAS la caisse', async () => {
  const av = await import('../src/avoirs.ts');
  const avant = av.lireCompte('acheteur')!.abonne_jusqu_a;
  const r = await fetch(`${racine}/api/abonner`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service': SERVICE },
    body: JSON.stringify({ reference: 'pay-vol', compte: 'acheteur', jours: 400, palier: 'whale' }),
  });
  assert.equal(r.status, 401, 'sans le secret de caisse, c’est refusé');
  assert.equal(av.lireCompte('acheteur')!.abonne_jusqu_a, avant, '⛔ la base n’a pas bougé');
});

test('⛔ un secret de caisse FAUX est refusé lui aussi', async () => {
  const r = await payer({ reference: 'pay-x', compte: 'acheteur', jours: 30, palier: 'crevette' },
    { 'x-caisse': CAISSE + 'x' });
  assert.equal(r.status, 401);
});

/**
 * ⛔ SANS CAISSE CONFIGURÉE, LA ROUTE N'EXISTE PAS — et elle rend 404, pas 401.
 * Un 401 annoncerait « il y a une caisse ici, trouve la clé ». Une porte qu'on
 * n'a pas ouverte ne doit pas se signaler ; c'est déjà le choix fait pour
 * `/admin`, et pour la même raison.
 */
test('⛔ caisse non configurée ⇒ la route est INDISCERNABLE d’une adresse inconnue', async () => {
  const garde = process.env.ID_CAISSE;
  process.env.ID_CAISSE = '';
  const r = await payer({ reference: 'pay-y', compte: 'acheteur', jours: 30, palier: 'crevette' });
  assert.equal(r.status, 404, 'ni 401 ni 403 : 404');
  assert.equal(((await r.json()) as any).erreur, 'route inconnue');
  process.env.ID_CAISSE = garde;
});

test('⛔ les formes refusées le sont AVANT toute écriture', async () => {
  const av = await import('../src/avoirs.ts');
  const avant = av.lireCompte('acheteur')!.abonne_jusqu_a;
  const mauvais = [
    { reference: '', compte: 'acheteur', jours: 30, palier: 'crevette' },
    { reference: 'r1', compte: 'acheteur', jours: 0, palier: 'crevette' },
    { reference: 'r2', compte: 'acheteur', jours: 401, palier: 'crevette' },
    { reference: 'r3', compte: 'acheteur', jours: 1.5, palier: 'crevette' },
    { reference: 'r4', compte: 'acheteur', jours: 30, palier: 'member' },
    { reference: 'r5', compte: 'acheteur', jours: 30, palier: 'baleine' },
    { reference: 'r6', compte: 'personne', jours: 30, palier: 'crevette' },
  ];
  for (const corps of mauvais) {
    const r = await payer(corps);
    assert.equal(r.status, 400, JSON.stringify(corps));
    assert.equal(av.lireCompte('acheteur')!.abonne_jusqu_a, avant, `⛔ « ${JSON.stringify(corps)} » n’écrit RIEN`);
  }
  // ⭐ ET LA RÉFÉRENCE N'EST PAS CONSOMMÉE PAR UN REFUS : sinon un webhook mal
  //   formé brûlerait la référence, et le paiement corrigé serait pris pour un
  //   rejeu — l'argent encaissé, la porte jamais ouverte.
  const bon = await payer({ reference: 'r6', compte: 'acheteur', jours: 30, palier: 'crevette' });
  assert.equal(((await bon.json()) as any).rejeu, false,
    '⛔ une référence refusée doit rester utilisable');
});

test('⭐ la table des paiements garde la trace, et rien d’autre', async () => {
  const { q } = await import('../src/db.ts');
  const lignes = q<{ reference: string; palier: string; jours: number }>(
    'SELECT reference, palier, jours FROM paiements ORDER BY reference');
  assert.ok(lignes.length >= 3, `${lignes.length} paiement(s) inscrit(s)`);
  // ⛔ AUCUN MONTANT NI MOYEN DE PAIEMENT DANS LE SCHÉMA : ce service ouvre des
  //    portes, il ne tient pas de comptabilité.
  const colonnes = Object.keys(lignes[0] ?? {});
  for (const interdit of ['montant', 'devise', 'carte', 'email']) {
    assert.ok(!colonnes.includes(interdit), `⛔ « ${interdit} » n’a rien à faire ici`);
  }
});
