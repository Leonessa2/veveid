// ⚠️ VeVePreda/veveid — src/rappels.ts   (FICHIER NEUF — lot 201)
// ═══════════════════════════════════════════════════════════════════════════
//  LE RAPPEL AVANT EXPIRATION — un seul courriel, jamais cinq
// ═══════════════════════════════════════════════════════════════════════════
//
// ⭐⭐⭐ ARBITRAGE DE PREDA (25/08) : un courriel CINQ JOURS AVANT la fin, et
// une bannière sur `/compte/`. Les deux se servent du même chiffre, et ce
// fichier ne fabrique que le premier — la bannière lit `jours_restants` sur
// `GET /session/<sid>`, une route qui existait déjà.
//
// 🔴🔴🔴 LE PIÈGE DE CE LOT TIENT EN UNE PHRASE : *une tâche qui tourne tous
// les jours et qui cherche « les abonnements qui finissent dans cinq jours »
// trouve les mêmes comptes CINQ JOURS DE SUITE.* Sans marque, quelqu'un qui
// paie 60 $ par an reçoit cinq fois le même courriel — ce qui ressemble
// exactement à un service cassé, et ce qui fait cliquer sur « spam ».
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔑 LA CLÉ EST (compte, ÉCHÉANCE), ET C'EST TOUT LE MÉCANISME
// ═══════════════════════════════════════════════════════════════════════════
// ⛔ PAS (compte, date du jour) : ça n'empêche que le doublon du même jour.
// ⛔ PAS (compte) seul : ce compte ne serait plus JAMAIS rappelé, y compris
//    l'année suivante — un silence qui ne se remarque qu'au non-renouvellement.
// ⭐⭐⭐ (compte, échéance) fait les deux d'un coup : tant que la date de fin
//    ne bouge pas, le rappel ne repart pas ; dès qu'il renouvelle, l'échéance
//    CHANGE, donc la clé change, donc le rappel se réarme tout seul. Il n'y a
//    rien à purger, rien à remettre à zéro, et aucune tâche de ménage à écrire.
//
// ⭐ MÊME DISCIPLINE QUE `paiements` (lot 198) : la clé primaire REFUSE le
//   doublon en une seule opération indivisible. ⛔ On ne lit pas « existe-t-il
//   déjà ? » avant d'écrire : deux passages simultanés passeraient tous les
//   deux le test avant que l'un n'écrive. C'est la base qui tranche.

import { q, q1, run, now } from './db.ts';

/** ⭐ CINQ JOURS, ET LE NOMBRE EST NOMMÉ ICI. Preda l'a choisi ; s'il change
 *  d'avis, il change à un seul endroit — et `/sante` le publie, pour qu'on
 *  puisse lire la valeur EN PRODUCTION au lieu de la déduire du dépôt. */
export const JOURS_AVANT = Number(process.env.RAPPEL_JOURS) > 0
  ? Math.min(60, Math.floor(Number(process.env.RAPPEL_JOURS)))
  : 5;

export interface Echeant {
  id: string;
  email: string;
  palier: string | null;
  abonne_jusqu_a: string;
  jours: number;
}

/** ⭐ LE NOMBRE DE JOURS RESTANTS, ARRONDI VERS LE HAUT ET JAMAIS NÉGATIF.
 *
 *  ⚠️ `ceil`, PAS `round` : à 4 h de la fin, « il reste 0 jour » est faux et
 *  inquiétant — l'accès est encore ouvert. On dit « 1 jour » tant qu'il reste
 *  quoi que ce soit, et `0` seulement quand c'est fini. Un compteur qui
 *  annonce zéro alors que la porte est ouverte fait payer dans la panique, ou
 *  écrire au support.
 */
export function joursRestants(fin: string | null | undefined, maintenant = Date.now()): number | null {
  if (!fin) return null;
  const t = Date.parse(fin);
  if (!Number.isFinite(t)) return null;
  const reste = t - maintenant;
  return reste <= 0 ? 0 : Math.ceil(reste / 86_400_000);
}

/**
 * Les comptes dont l'abonnement finit dans les `JOURS_AVANT` prochains jours,
 * et qui n'ont pas encore reçu le rappel POUR CETTE ÉCHÉANCE-LÀ.
 *
 * ⛔ `email IS NOT NULL` : un compte créé par portefeuille seul n'a aucune
 *    adresse. Le rappel ne lui est pas « raté », il est SANS OBJET — et
 *    tenter l'envoi remplirait le journal d'échecs qui ne disent rien.
 * ⛔ `supprime_le IS NULL` : quelqu'un qui a demandé la suppression de son
 *    compte ne doit pas recevoir une invitation à repayer. C'est la faute la
 *    plus embarrassante que ce lot pouvait commettre.
 * ⚠️ ET LA BORNE BASSE EST `now()`, PAS ZÉRO : un abonnement DÉJÀ EXPIRÉ ne
 *    reçoit pas de « rappel avant expiration ». Sans cette borne, la première
 *    exécution enverrait un rappel à tous les anciens abonnés de l'histoire du
 *    service, d'un coup.
 */
export function comptesEcheants(maintenant = Date.now()): Echeant[] {
  const debut = new Date(maintenant).toISOString();
  const fin = new Date(maintenant + JOURS_AVANT * 86_400_000).toISOString();
  const lignes = q<{ id: string; email: string; palier: string | null; abonne_jusqu_a: string }>(
    `SELECT c.id, c.email, c.palier, c.abonne_jusqu_a
       FROM comptes c
       LEFT JOIN rappels r ON r.compte_id = c.id AND r.echeance = c.abonne_jusqu_a
      WHERE c.abonne_jusqu_a IS NOT NULL
        AND c.abonne_jusqu_a > ?
        AND c.abonne_jusqu_a <= ?
        AND c.supprime_le IS NULL
        AND c.email IS NOT NULL
        AND c.email <> ''
        AND r.compte_id IS NULL
      ORDER BY c.abonne_jusqu_a ASC`,
    debut, fin);
  return lignes.map((l) => ({ ...l, jours: joursRestants(l.abonne_jusqu_a, maintenant) ?? 0 }));
}

/**
 * Pose la marque. Rend `true` si C'EST NOUS qui l'avons posée.
 *
 * ⭐⭐⭐ `INSERT OR IGNORE` PUIS LECTURE DU NOMBRE DE LIGNES : c'est ce qui rend
 * l'appelant sûr. Deux passages concurrents appellent tous les deux cette
 * fonction ; un seul obtient `true`, donc un seul envoie. ⛔ Un `SELECT` suivi
 * d'un `INSERT` laisserait passer les deux.
 */
export function marquerRappel(compteId: string, echeance: string): boolean {
  const r = run(
    'INSERT OR IGNORE INTO rappels (compte_id, echeance, envoye_le, ok) VALUES (?,?,?,0)',
    compteId, echeance, now());
  return Number(r.changes ?? 0) === 1;
}

/** ⭐ L'ISSUE DE L'ENVOI EST ÉCRITE APRÈS COUP. La marque protège du doublon
 *  DÈS AVANT l'envoi ; ce drapeau-ci ne sert qu'à SAVOIR, depuis `/sante`, si
 *  les courriels partent vraiment. ⛔ Sans lui, un rappel marqué mais jamais
 *  parti serait indistinguable d'un rappel réussi — et le silence de Brevo
 *  passerait pour un service qui marche. */
export const noterIssue = (compteId: string, echeance: string, ok: boolean) => {
  run('UPDATE rappels SET ok=? WHERE compte_id=? AND echeance=?', ok ? 1 : 0, compteId, echeance);
};

export interface Bilan {
  quand: string; vus: number; envoyes: number; rates: number; cause: string | null;
}
let _dernier: Bilan | null = null;
export const dernierPassage = (): Bilan | null => _dernier;
export const oublierPassage = () => { _dernier = null; };

/**
 * Un passage complet. ⭐ Il rend son bilan ET le mémorise pour `/sante`.
 *
 * 🔴🔴🔴 ON MARQUE **AVANT** D'ENVOYER, ET C'EST L'INVERSE DU CHOIX FAIT POUR
 * LA CAISSE — le raisonnement, lui, est le même : *des deux ordres, on prend
 * celui dont le pire cas coûte le moins cher.*
 *   · marquer puis envoyer → si l'envoi échoue, le rappel est PERDU pour cette
 *     échéance. Coût : une personne ne reçoit pas son courriel. ⭐ Et elle voit
 *     quand même la bannière sur `/compte/`, qui ne dépend pas de ceci.
 *   · envoyer puis marquer → si la marque échoue, le courriel REPART tous les
 *     jours pendant cinq jours. Coût : cinq courriels identiques à un client
 *     qui paie, et une réputation d'expéditeur qu'on ne récupère pas.
 * ⇒ Le premier. ⚠️ Et le drapeau `ok` rend la perte VISIBLE, ce qui est la
 *   seule chose qui rende ce choix acceptable.
 *
 * ⛔ IL NE LÈVE JAMAIS. Il tourne dans un minuteur : une exception qui
 *    remonterait tuerait le processus du service d'identité — donc la
 *    connexion de tout le monde — pour un courriel de rappel.
 */
export async function passerLesRappels(
  envoyerUn: (e: Echeant) => Promise<boolean>,
  maintenant = Date.now(),
): Promise<Bilan> {
  const bilan: Bilan = { quand: new Date(maintenant).toISOString(), vus: 0, envoyes: 0, rates: 0, cause: null };
  try {
    const liste = comptesEcheants(maintenant);
    bilan.vus = liste.length;
    for (const e of liste) {
      if (!marquerRappel(e.id, e.abonne_jusqu_a)) continue;   // quelqu'un d'autre l'a pris
      let ok = false;
      try { ok = await envoyerUn(e); } catch { ok = false; }
      noterIssue(e.id, e.abonne_jusqu_a, ok);
      if (ok) bilan.envoyes++; else bilan.rates++;
    }
  } catch (e) {
    bilan.cause = e instanceof Error ? e.message : String(e);
  }
  _dernier = bilan;
  return bilan;
}

/** ⭐ POUR `/sante` : combien de rappels sont partis, et combien ont raté.
 *  ⛔ Aucune adresse, aucun identifiant : cette route répond à tout le monde. */
export function etatDesRappels() {
  const t = q1<{ n: number; ok: number }>(
    'SELECT COUNT(*) AS n, COALESCE(SUM(ok),0) AS ok FROM rappels');
  const total = Number(t?.n ?? 0);
  const ok = Number(t?.ok ?? 0);
  return { jours_avant: JOURS_AVANT, poses: total, partis: ok, rates: total - ok, dernier: _dernier };
}
