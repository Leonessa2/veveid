// ⚠️ DEPOT : VeVePreda/veveid   ·   CHEMIN : test/rappels.test.ts   (FICHIER NEUF — lot 201)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Server } from 'node:http';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔔 LOT 201 — LE RAPPEL AVANT EXPIRATION
 * ═══════════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ CE QUE CE FICHIER GARDE TIENT EN UNE LIGNE : *un seul courriel par
 * échéance, et un rappel qui se réarme au renouvellement.* Le reste (le texte,
 * la mise en page) se voit à l'œil ; ces deux propriétés-là, non — elles ne se
 * manifestent qu'au bout de cinq jours, chez un client qui paie.
 *
 * 🔴 LE MODE DE PANNE QU'ON REDOUTE EST LE DOUBLON, pas l'absence : une tâche
 * qui cherche chaque jour « les abonnements qui finissent dans cinq jours »
 * retrouve les MÊMES comptes cinq jours de suite.
 *
 * ⛔ ET LA SECONDE PROPRIÉTÉ EST AUSSI IMPORTANTE QUE LA PREMIÈRE : un garde
 * trop large (une marque par compte, sans échéance) supprimerait le doublon ET
 * le rappel de l'année suivante. Un banc qui ne mesurerait que le doublon
 * serait vert sur cette panne-là — et elle ne se voit qu'au non-renouvellement.
 */

const dossier = mkdtempSync(join(tmpdir(), 'veveid-rappels-'));
let serveur: Server;
let racine = '';
let R: typeof import('../src/rappels.ts');
let base: DatabaseSync;

const J = 86_400_000;
const T0 = Date.parse('2026-09-01T12:00:00.000Z');
const dans = (jours: number) => new Date(T0 + jours * J).toISOString();

before(async () => {
  const f = join(dossier, 'rappels.db');
  const db = new DatabaseSync(f);
  db.exec(`CREATE TABLE comptes (
    id TEXT PRIMARY KEY, wallet TEXT, email TEXT, verifie INTEGER NOT NULL DEFAULT 0,
    verifie_le TEXT, cree_le TEXT NOT NULL, abonne_jusqu_a TEXT, supprime_le TEXT);`);
  const ins = db.prepare(
    'INSERT INTO comptes (id, email, verifie, cree_le, abonne_jusqu_a, supprime_le) VALUES (?,?,?,?,?,?)');
  // ⭐ SIX COMPTES, UN PAR RAISON D'ÊTRE OU DE NE PAS ÊTRE RAPPELÉ. Un jeu
  //   d'essai qui ne porterait que le cas heureux laisserait les cinq filtres
  //   de la requête non mesurés — et un filtre non mesuré est un filtre qu'on
  //   peut retirer sans que rien ne rougisse.
  ins.run('dans3',    'dans3@exemple.net',    1, dans(-300), dans(3),  null);
  ins.run('dans5',    'cinq@exemple.net',     1, dans(-300), dans(4.9), null);
  ins.run('dans30',   'loin@exemple.net',     1, dans(-300), dans(30), null);
  ins.run('expire',   'fini@exemple.net',     1, dans(-300), dans(-2), null);
  ins.run('supprime', 'parti@exemple.net',    1, dans(-300), dans(2),  dans(-1));
  ins.run('sansmail',  null,                  0, dans(-300), dans(2),  null);
  db.close();

  process.env.DB_PATH = f;
  process.env.SITE_DEFAUT = 'veveprice';
  process.env.SESSION_SECRET = 'secret-de-banc-0123456789abcdef';
  process.env.ID_SERVICE = 'secret-de-service-des-jeux-0001';
  process.env.JEUX = 'veveprice=https://veveprice.com';
  process.env.URL_PUBLIQUE = 'https://id.exemple.net';
  // ⛔ AUCUNE CLÉ BREVO : ce banc ne doit joindre personne. L'envoi est une
  //   fonction qu'on lui passe — c'est précisément ce qui rend le mécanisme
  //   éprouvable sans réseau.
  delete process.env.BREVO_CLE;

  const s = await import('../server.ts');
  serveur = s.serveur;
  await new Promise<void>((r) => serveur.listen(0, '127.0.0.1', r));
  racine = `http://127.0.0.1:${(serveur.address() as { port: number }).port}`;
  R = await import('../src/rappels.ts');
  base = new DatabaseSync(f);
});

after(async () => {
  await new Promise<void>((r) => serveur.close(() => r()));
  try { base.close(); } catch { /* déjà fermée */ }
  rmSync(dossier, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
test('① le compte à rebours arrondit VERS LE HAUT et ne descend pas sous zéro', () => {
  // ⚠️ À quatre heures de la fin, « 0 jour » est FAUX : la porte est encore
  //    ouverte. Un compteur qui annonce zéro pendant que l'accès marche fait
  //    payer dans la panique — ou écrire au support.
  assert.equal(R.joursRestants(new Date(T0 + 4 * 3600_000).toISOString(), T0), 1);
  assert.equal(R.joursRestants(new Date(T0 + 3 * J).toISOString(), T0), 3);
  assert.equal(R.joursRestants(new Date(T0 + 2.1 * J).toISOString(), T0), 3);
  // ⛔ Un abonnement fini rend 0, jamais un négatif : « il reste −4 jours »
  //    est une phrase qu'aucune bannière ne doit pouvoir afficher.
  assert.equal(R.joursRestants(new Date(T0 - 4 * J).toISOString(), T0), 0);
  // ⭐ ET `null` N'EST PAS `0`. « Pas abonné » et « ça finit aujourd'hui » sont
  //   deux phrases opposées à l'écran ; les aplatir en un seul chiffre, c'est
  //   annoncer une fin de droits à quelqu'un qui n'a jamais payé.
  assert.equal(R.joursRestants(null, T0), null);
  assert.equal(R.joursRestants('pas une date', T0), null);
});

test('② la fenêtre retient ce qui finit bientôt, et RIEN d\'autre', () => {
  const vus = R.comptesEcheants(T0).map((e) => e.id).sort();
  // ⭐ L'assertion porte sur la LISTE ENTIÈRE, pas sur « dans3 est dedans ».
  //   Un `includes()` serait vert le jour où le compte supprimé s'y ajoute.
  assert.deepEqual(vus, ['dans3', 'dans5']);
});

test('③ marquer deux fois la même échéance : la seconde est REFUSÉE', () => {
  assert.equal(R.marquerRappel('temoin', dans(3)), true);
  assert.equal(R.marquerRappel('temoin', dans(3)), false);
  // ⭐ …mais une AUTRE échéance passe : c'est la moitié de l'invariant qu'un
  //   garde par compte seul aurait cassée.
  assert.equal(R.marquerRappel('temoin', dans(370)), true);
  base.prepare('DELETE FROM rappels WHERE compte_id=?').run('temoin');
});

test('④ deux passages le même jour : DEUX comptes vus, UN SEUL courriel chacun', async () => {
  const partis: string[] = [];
  const envoi = async (e: { email: string }) => { partis.push(e.email); return true; };

  const un = await R.passerLesRappels(envoi, T0);
  assert.equal(un.vus, 2);
  assert.equal(un.envoyes, 2);
  assert.equal(un.rates, 0);

  // ⭐⭐⭐ LE SECOND PASSAGE EST LE CŒUR DE CE FICHIER. Sans la marque, il
  //   renverrait les deux mêmes courriels — et ça recommencerait chaque jour
  //   jusqu'à l'échéance. C'est exactement la panne que Preda a nommée.
  const deux = await R.passerLesRappels(envoi, T0 + 3600_000);
  assert.equal(deux.vus, 0, 'un second passage ne doit plus voir personne');
  assert.equal(partis.length, 2, `⛔ ${partis.length} courriels pour 2 comptes`);
});

test('⑤ après renouvellement, le rappel SE RÉARME tout seul', async () => {
  // Il prolonge : l'échéance change, donc la clé change.
  base.prepare('UPDATE comptes SET abonne_jusqu_a=? WHERE id=?').run(dans(368), 'dans3');
  const partis: string[] = [];
  const envoi = async (e: { email: string }) => { partis.push(e.email); return true; };

  // Rien à un an de la fin…
  assert.equal((await R.passerLesRappels(envoi, T0)).vus, 0);
  // …mais tout revient quand la NOUVELLE échéance approche.
  const tard = T0 + 365 * J;
  const b = await R.passerLesRappels(envoi, tard);
  assert.equal(b.envoyes, 1, '⛔ un garde par compte aurait tué le rappel de l\'année suivante');
  assert.deepEqual(partis, ['dans3@exemple.net']);
});

test('⑥ un envoi qui échoue est MARQUÉ QUAND MÊME, et il se voit', async () => {
  base.prepare('UPDATE comptes SET abonne_jusqu_a=? WHERE id=?').run(dans(2), 'dans30');
  let appels = 0;
  const casse = async () => { appels++; throw new Error('Brevo est muet'); };

  const b = await R.passerLesRappels(casse, T0);
  assert.equal(b.envoyes, 0);
  assert.equal(b.rates, 1);
  assert.equal(appels, 1);

  // 🔴🔴🔴 L'ARBITRAGE, MESURÉ : on marque AVANT d'envoyer. Le pire cas est
  //   donc « un rappel perdu », jamais « cinq courriels identiques ». Un banc
  //   qui vérifierait l'inverse validerait le choix opposé sans le dire.
  const suite = await R.passerLesRappels(casse, T0 + 3600_000);
  assert.equal(suite.vus, 0, '⛔ un envoi raté ne doit PAS repartir chaque jour');
  assert.equal(appels, 1);

  // ⭐ …et la perte est VISIBLE. C'est la seule chose qui rende ce choix
  //   acceptable : sans ce drapeau, un rappel jamais parti ressemblerait
  //   exactement à un rappel réussi.
  const etat = R.etatDesRappels();
  assert.ok(etat.rates >= 1, `⛔ le raté ne se voit nulle part (${JSON.stringify(etat)})`);
});

test('⑦ /sante publie l\'état des rappels, sans une seule adresse', async () => {
  const r = await fetch(`${racine}/sante`);
  assert.equal(r.status, 200);
  const j = await r.json() as any;
  assert.ok(j.rappels, '⛔ /sante ne dit rien des rappels : la mesure n\'atteint pas son lecteur');
  assert.equal(j.rappels.jours_avant, R.JOURS_AVANT);
  assert.equal(typeof j.rappels.partis, 'number');
  // ⛔ CETTE ROUTE EST PUBLIQUE. Une adresse qui s'y glisserait serait lisible
  //    par n'importe qui, sans session et sans secret.
  const brut = JSON.stringify(j.rappels);
  assert.ok(!/@/.test(brut), `⛔ une adresse est sortie par /sante : ${brut}`);
});

test('⑧ /session/<sid> porte le compte à rebours de la bannière', async () => {
  // ⭐ ON PASSE PAR HTTP, pas par la fonction : ce qu'il faut garder, c'est que
  //   le CHIFFRE SORT VRAIMENT de la route que le middleware de veve-sites
  //   appelle déjà. Une route juste, branchée nulle part, ne sert à rien.
  base.prepare('UPDATE comptes SET abonne_jusqu_a=? WHERE id=?')
    .run(new Date(Date.now() + 3 * J).toISOString(), 'dans5');
  // 🔴🔴🔴 ON OUVRE LA SESSION PAR LE MODULE, PAS EN FORGEANT LA LIGNE SQL.
  //   Première version : un INSERT écrit à la main dans `sessions`, avec ma
  //   propre recette d'empreinte et mes propres noms de colonnes. Elle a
  //   rougi sur « table sessions has no column named cree_le » — la colonne
  //   s'appelle `cree`.
  //   ⭐⭐⭐ Et l'erreur de fond n'est pas le nom : c'est qu'un banc qui RECOPIE
  //   le schéma et la fabrique d'empreinte de son sujet devient une SECONDE
  //   IMPLÉMENTATION. Le jour où le service change sa recette, ce banc reste
  //   vert sur sa propre version — il mesure sa copie, plus le service.
  //   ⇒ `ouvrirSession()` est la porte du service ; on passe par elle.
  const { ouvrirSession } = await import('../src/sessions.ts');
  const jeton = ouvrirSession('dans5');

  const r = await fetch(`${racine}/session/${jeton}`);
  if (r.status !== 200) {
    // ⭐ ON LE DIT, ON NE SE TAIT PAS. Si l'empreinte de session ne se fabrique
    //   pas comme ici, ce contrôle devient INDÉCIDABLE — et un banc muet
    //   ressemble trait pour trait à un banc vert.
    assert.fail(`⏸️ session non reconnue (${r.status}) : la fabrique d'empreinte de ce banc ne suit plus celle du service`);
  }
  const j = await r.json() as any;
  assert.equal(j.palier !== undefined, true);
  assert.equal(j.jours_restants, 3, `⛔ la bannière lirait ${j.jours_restants}`);
});

test('⑨ deux passages QUI SE CHEVAUCHENT : toujours un seul courriel par compte', async () => {
  // 🔴🔴🔴 CE CONTRÔLE EXISTE PARCE QU'UNE INJECTION N'A PAS MORDU.
  // En retirant le garde `if (!marquerRappel(…)) continue;` du module, les huit
  // contrôles précédents restaient VERTS — la requête SQL écarte déjà les
  // comptes marqués, donc un second passage SÉQUENTIEL ne voit plus personne.
  // Le garde ne sert qu'aux passages qui SE CHEVAUCHENT, et rien ici n'en
  // créait.
  // ⭐⭐⭐ *Une injection qui ne mord pas accuse le jeu d'essai, jamais le code.*
  // Le garde était bon ; c'est le banc qui ne l'atteignait pas — donc ce
  // chemin n'était pas sûr, il était NON MESURÉ.
  //
  // ⚠️ LE SCÉNARIO, PRÉCISÉMENT : le passage A lit la liste [x, y], marque x,
  // puis ATTEND l'envoi. Le passage B démarre pendant cette attente, relit la
  // liste — x est déjà marqué, il obtient [y] — marque y et attend. A reprend
  // sur y : sa marque est REFUSÉE, et c'est ce refus qui empêche le doublon.
  // Sans le garde, y partirait deux fois.
  // ⚠️ CE CONTRÔLE REMET LA BASE DANS UN ÉTAT QU'IL DÉCLARE, il ne suppose
  //    rien de ce que les huit précédents ont laissé. Première rédaction :
  //    « deux comptes », alors que les tests ⑤ et ⑥ avaient rendu un TROISIÈME
  //    compte éligible. Il a rougi sur du code juste, en annonçant « 3 envois
  //    pour 2 comptes » — et il avait raison sur le chiffre, tort sur l'attendu.
  //    ⭐⭐⭐ *Mon instrument garde-t-il un état entre deux mesures ?* — ici,
  //    l'état vient des mesures d'AVANT, ce qui est pire : il change quand on
  //    ajoute un contrôle ailleurs dans le fichier.
  base.prepare('DELETE FROM rappels').run();
  base.prepare('UPDATE comptes SET abonne_jusqu_a = NULL').run();
  base.prepare('UPDATE comptes SET abonne_jusqu_a=? WHERE id IN (?,?)')
    .run(dans(2), 'dans3', 'dans5');
  // ⭐ ET ON MESURE COMBIEN LA REQUÊTE EN RETIENT, plutôt que d'écrire « 2 ».
  //   Un nombre en dur mesure le jeu d'essai dont il vient.
  const attendus = R.comptesEcheants(T0).length;
  assert.equal(attendus, 2, `⛔ le jeu d'essai n'est pas celui qu'on croit (${attendus})`);

  const partis: string[] = [];
  // ⭐ L'ENVOI DOIT RENDRE LA MAIN. Un envoi synchrone ne laisserait jamais le
  //   second passage démarrer, et le contrôle serait vert sans avoir rien
  //   croisé — un banc muet qui ressemble à un banc vert.
  const lent = async (e: { email: string }) => {
    await new Promise((r) => { setTimeout(r, 5); });
    partis.push(e.email);
    return true;
  };

  const [a, b] = await Promise.all([
    R.passerLesRappels(lent, T0),
    R.passerLesRappels(lent, T0),
  ]);

  assert.equal(a.envoyes + b.envoyes, attendus, `⛔ ${a.envoyes + b.envoyes} envois pour ${attendus} comptes`);
  assert.equal(partis.length, attendus, `⛔ ${partis.length} courriels partis : ${partis.join(', ')}`);
  assert.equal(new Set(partis).size, attendus, `⛔ un compte a reçu deux fois : ${partis.join(', ')}`);
});
