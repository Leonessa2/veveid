import { randomUUID } from 'node:crypto';
import { q, q1, run, now } from './db.ts';
import { normaliserSite } from './sites.ts';
import { fetchAvoirs } from './collectchain.ts';

/**
 * ⭐⭐ LES AVOIRS — les collectibles VeVe réellement détenus par un compte.
 *
 * (C'est ce que j'appelais « roster » par jargon. En clair : la liste des
 * pièces de la collection, celles qui deviennent des héros dans les jeux.)
 *
 * 🔴 POURQUOI C'EST ICI ET PAS DANS CHAQUE JEU. Trois raisons, dans
 *    l'ordre d'importance :
 *
 *  1. **UN SEUL QUOTA.** Chaque lecture tape CollectScan, un service tiers
 *     gratuit. Avec trois jeux qui relisent chacun tous les portefeuilles,
 *     on triple la charge pour obtenir trois fois la même réponse — et on
 *     finit par se faire fermer la porte.
 *  2. **UNE SEULE VÉRITÉ.** Deux jeux qui synchronisent séparément
 *     divergent : l'un voit une revente, l'autre pas encore. Le joueur
 *     constate que son héros existe ici et plus là.
 *  3. **UN SEUL ENDROIT À CORRIGER** le jour où VeVe change son API.
 */

export interface Avoir {
  mint_key: string; nom: string; edition: number;
  rarete: string | null; image: string | null; vu_le: string;
}

/** La clé d'un mint : `nom:edition`. ⛔ Ne jamais la « nettoyer ». */
export const mintKeyDe = (h: { name: string; edition: number | null }) => `${h.name}:${h.edition ?? 0}`;

export const avoirsDe = (compteId: string) =>
  q<Avoir>('SELECT mint_key, nom, edition, rarete, image, vu_le FROM avoirs WHERE compte_id=? ORDER BY nom, edition', compteId);

export const dernierSync = (compteId: string) =>
  q1<{ dernier: string; resultat: string; complet: number }>(
    'SELECT dernier, resultat, complet FROM sync_log WHERE compte_id=?', compteId);

export interface Bilan {
  vus: number; nouveaux: number; partis: number; complet: boolean; erreur?: string;
}

/**
 * Relit la chaîne et met les avoirs à jour.
 *
 * 🔴 UNE VUE PARTIELLE NE RETIRE RIEN. Piège payé sur MightysArena : la
 *    pagination s'arrêtait à trois pages, et un collectionneur de deux
 *    cents pièces voyait cinquante combattants gelés à tort à chaque tour.
 *    Retirer est destructeur, lire ne l'est pas — sans certitude, on ne
 *    retire pas. Le drapeau `complet` est donc porté jusqu'au journal.
 */
export async function synchroniser(
  compteId: string, wallet: string, lire: typeof fetchAvoirs = fetchAvoirs,
): Promise<Bilan> {
  let avoirs;
  try { avoirs = await lire(wallet.toLowerCase()); }
  catch {
    run(
      `INSERT INTO sync_log (compte_id, dernier, resultat, complet) VALUES (?,?,?,0)
       ON CONFLICT(compte_id) DO UPDATE SET dernier=excluded.dernier, resultat=excluded.resultat, complet=0`,
      compteId, now(), 'chaîne injoignable',
    );
    return { vus: 0, nouveaux: 0, partis: 0, complet: false, erreur: 'chaîne injoignable' };
  }

  const vus = new Set<string>();
  let nouveaux = 0;
  for (const h of avoirs.liste) {
    const mk = mintKeyDe(h);
    vus.add(mk);
    const existait = q1('SELECT 1 FROM avoirs WHERE compte_id=? AND mint_key=?', compteId, mk);
    if (!existait) nouveaux++;
    run(
      `INSERT INTO avoirs (compte_id, mint_key, nom, edition, rarete, image, vu_le) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(compte_id, mint_key) DO UPDATE SET
         rarete=excluded.rarete, image=excluded.image, vu_le=excluded.vu_le`,
      compteId, mk, h.name, h.edition ?? 0, h.rarity ?? null, h.image ?? null, now(),
    );
  }

  let partis = 0;
  if (avoirs.complet) {
    for (const a of avoirsDe(compteId)) {
      if (vus.has(a.mint_key)) continue;
      run('DELETE FROM avoirs WHERE compte_id=? AND mint_key=?', compteId, a.mint_key);
      partis++;
    }
  }
  const resultat = `${avoirs.liste.length} vus, ${nouveaux} nouveaux, ${partis} partis`
    + (avoirs.complet ? '' : ' — vue partielle, rien retiré');
  run(
    `INSERT INTO sync_log (compte_id, dernier, resultat, complet) VALUES (?,?,?,?)
     ON CONFLICT(compte_id) DO UPDATE SET dernier=excluded.dernier, resultat=excluded.resultat, complet=excluded.complet`,
    compteId, now(), resultat, avoirs.complet ? 1 : 0,
  );
  return { vus: avoirs.liste.length, nouveaux, partis, complet: avoirs.complet };
}

// ═════════════════════════════════════════════════════════════════════════
// Le compte
// ═════════════════════════════════════════════════════════════════════════

/**
 * ⭐⭐ UN COMPTE PEUT N'AVOIR QUE L'UN DES DEUX (lot 89).
 *
 *  - `email` sans `wallet`  : le cas le plus courant. Quelqu'un s'inscrit
 *    pour suivre des prix. Il vaut `member`, il n'a rien à prouver.
 *  - `wallet` sans `email`  : les comptes nés avant le lot 89, et le
 *    parcours des jeux, qui part encore du portefeuille.
 *  - les deux              : un membre qui a vérifié sa collection.
 *
 * 🔴 `verifie` NE VEUT PAS DIRE « COMPTE VALIDE ». Il veut dire « LE
 *    PORTEFEUILLE EST PROUVÉ », et rien d'autre. Le lire comme un état du
 *    compte ferait d'un membre parfaitement légitime un compte à moitié
 *    ouvert — c'est précisément le mur qu'on est en train de retirer.
 */
export interface Compte {
  id: string; site: string; wallet: string | null; email: string | null;
  verifie: number; verifie_le: string | null;
  cree_le: string; abonne_jusqu_a: string | null; supprime_le: string | null;
  /** 🔴 LOT 194 — CE QUI A ÉTÉ ACHETÉ. `null` sur un compte gratuit, et sur
   *  les abonnements d'avant ce lot que la migration n'aurait pas atteints :
   *  `paliDe()` retombe alors sur `crevette`, le seul palier qui existait. */
  palier: string | null;
}

/**
 * 🔥 LOT 107 — TOUTES CES LECTURES SONT MAINTENANT PAR SITE.
 * ⛔ Une requête sur `comptes` qui ne filtre pas sur `site` traverse la
 *    cloison. Elle ne lèvera aucune erreur : elle rendra le compte d'un autre
 *    site, avec son portefeuille — c'est-à-dire exactement le lien entre les
 *    sites que Preda a demandé de supprimer.
 * ⚠️ Le site est un paramètre EXPLICITE, jamais deviné à l'intérieur : c'est
 *    l'appelant qui sait d'où vient la personne.
 */
export function creerOuLireCompte(site: string, wallet: string): Compte {
  const s = normaliserSite(site);
  const w = wallet.trim().toLowerCase();
  const existant = q1<Compte>('SELECT * FROM comptes WHERE site=? AND wallet=?', s, w);
  if (existant) return existant;
  const id = randomUUID();
  run('INSERT INTO comptes (id, site, wallet, cree_le) VALUES (?,?,?,?)', id, s, w, now());
  return q1<Compte>('SELECT * FROM comptes WHERE id=?', id)!;
}

/**
 * La porte d'entrée par e-mail. Symétrique de `creerOuLireCompte`, et
 * volontairement aussi bête : on ne crée RIEN d'autre que la ligne.
 *
 * ⚠️ L'appelant a déjà normalisé l'adresse (`lien_magique.normaliser`).
 *    On re-normalise quand même : cette fonction sera un jour appelée
 *    depuis ailleurs, et un compte en double créé par une majuscule est
 *    invisible jusqu'au jour où la personne ne retrouve plus ses données.
 */
export function creerOuLireCompteParEmail(site: string, email: string): Compte {
  const s = normaliserSite(site);
  const e = email.trim().toLowerCase();
  const existant = q1<Compte>('SELECT * FROM comptes WHERE site=? AND email=?', s, e);
  if (existant) return existant;
  const id = randomUUID();
  run('INSERT INTO comptes (id, site, email, cree_le) VALUES (?,?,?,?)', id, s, e, now());
  return q1<Compte>('SELECT * FROM comptes WHERE id=?', id)!;
}

export const lireCompteParEmail = (site: string, email: string) =>
  q1<Compte>('SELECT * FROM comptes WHERE site=? AND email=?',
    normaliserSite(site), email.trim().toLowerCase());

/**
 * ⭐⭐⭐ LES TROIS PALIERS QUI SE VENDENT, ÉCRITS ICI ET NULLE PART AILLEURS.
 * ⛔ `visitor`, `free` et `member` n'y sont PAS, et ce n'est pas un oubli :
 *    ils ne s'achètent pas, ils se déduisent. Les mélanger permettrait
 *    d'« accorder un abonnement member », c'est-à-dire de vendre le gratuit.
 * ⚠️ Les noms doivent rester ceux de `PALIERS` dans `access.mjs` (veve-sites).
 *    Ce service dit le palier, l'autre décide ce qu'il ouvre : un nom qui
 *    diverge ne lèverait rien, il refuserait juste tout, en silence.
 */
export const PALIERS_VENDUS = ['crevette', 'langouste', 'whale'] as const;
export const palierVendu = (p: unknown): p is typeof PALIERS_VENDUS[number] =>
  typeof p === 'string' && (PALIERS_VENDUS as readonly string[]).includes(p);

/**
 * ⭐ Le palier, en un seul endroit. Voir `access.mjs` côté veve-sites.
 *
 * 🔴🔴 LOT 194 — TROIS ÉTATS, ET L'ORDRE DES QUESTIONS COMPTE :
 *   1. pas de compte           → `visitor`
 *   2. compte sans abonnement  → `member` (gratuit) — ⛔ la colonne `palier`
 *      n'est PAS regardée : un abonnement expiré garde ce qu'il a acheté en
 *      mémoire, mais il ne l'OUVRE plus. Lire `palier` avant `estAbonne()`
 *      rendrait l'abonnement éternel, et personne ne le verrait avant le
 *      premier non-renouvellement.
 *   3. abonnement en cours     → ce qui a été acheté, `crevette` par repli.
 *
 * ⚠️ LE REPLI N'EST PAS DE LA PRUDENCE DÉCORATIVE : avant ce lot, un
 *    abonnement ne pouvait être que `crevette`. Sans lui, la migration aurait
 *    fait TOMBER à `member` tous ceux qui avaient déjà payé — une régression
 *    invisible, du côté des gens qui ont donné de l'argent.
 * ⛔ Et il valide le contenu : une valeur inconnue en base (faute de frappe,
 *    palier retiré du catalogue) retombe sur `crevette`, jamais sur elle-même.
 *    Une base ne dicte pas ce que le code accepte.
 */
export const paliDe = (c: Compte | undefined) =>
  !c ? 'visitor'
    : !estAbonne(c) ? 'member'
      : palierVendu(c.palier) ? c.palier : 'crevette';

export const lireCompte = (id: string) => q1<Compte>('SELECT * FROM comptes WHERE id=?', id);

/**
 * ⭐⭐ « CE PORTEFEUILLE APPARTIENT-IL DÉJÀ À QUELQU'UN ? »
 *
 * ⚠️ « Une ligne existe avec ce portefeuille » et « quelqu'un le détient »
 *    sont DEUX QUESTIONS. L'ancienne porte `/entrer` créait la ligne avant
 *    toute preuve : une adresse tapée puis abandonnée laisse une trace qui
 *    n'appartient à personne. La traiter comme une propriété reviendrait à
 *    laisser n'importe qui réserver le portefeuille d'un autre en le
 *    tapant une fois — et le vrai détenteur serait refusé pour toujours.
 *
 * On répond donc « oui » seulement si l'autre compte a quelque chose à
 * perdre : une preuve faite (`verifie`) ou une adresse e-mail.
 */
export const portefeuilleOccupe = (site: string, wallet: string, saufCompteId: string): boolean => {
  const autre = q1<{ verifie: number; email: string | null }>(
    'SELECT verifie, email FROM comptes WHERE site=? AND wallet=? AND id<>?',
    normaliserSite(site), wallet.trim().toLowerCase(), saufCompteId);
  return !!autre && (autre.verifie === 1 || !!autre.email);
};

/**
 * Pose le portefeuille sur un compte, AVANT toute preuve. ⛔ Il n'écrit
 * PAS `verifie` : seule la preuve de propriété (`defi.lier`) a le droit de
 * le faire. Un raccourci ici transformerait « j'ai tapé une adresse » en
 * « je la détiens », ce que ce service entier existe pour distinguer.
 */
export function poserPortefeuille(compteId: string, wallet: string): void {
  const w = wallet.trim().toLowerCase();
  // La trace abandonnée d'un compte sans valeur cède la place (voir defi.lier).
  const autre = q1<{ id: string }>(
    'SELECT id FROM comptes WHERE wallet=? AND id<>? AND verifie=0 AND email IS NULL', w, compteId);
  if (autre) run('UPDATE comptes SET wallet=NULL WHERE id=?', autre.id);
  run('UPDATE comptes SET wallet=? WHERE id=?', w, compteId);
}
export const estAbonne = (c: Compte) => !!c.abonne_jusqu_a && c.abonne_jusqu_a > now();

/**
 * 🔴 LOT 194 — LE PALIER EST UN TROISIÈME ARGUMENT, ET IL EST FACULTATIF.
 * ⭐ `= 'crevette'` par défaut : les appelants d'avant ce lot (les tests, et
 *    la route admin tant qu'elle n'envoyait rien) continuent d'accorder
 *    exactement ce qu'ils accordaient. Une signature élargie qui casse ses
 *    appelants est une migration déguisée en amélioration.
 * ⛔ UN PALIER INCONNU EST REFUSÉ, PAS CORRIGÉ. Écrire « crevette » à la
 *    place de « crevete » vendrait autre chose que ce qui a été payé, et le
 *    formulaire d'exploitation n'afficherait aucune différence. On refuse, et
 *    on le dit — c'est la même règle que les bornes de `jours` : *on exige la
 *    forme, on ne la devine pas.*
 * ⚠️ LE DERNIER GESTE DÉCIDE DU PALIER, y compris vers le bas. Accorder 30
 *    jours de `crevette` à un `whale` en cours prolonge la date ET redescend
 *    le palier. C'est voulu : un abonnement est ce qu'on vient d'acheter, pas
 *    le meilleur de ce qu'on a acheté un jour. Le message de retour NOMME le
 *    palier accordé, pour que le geste soit relisible à l'écran.
 */
export function accorderAbonnement(compteId: string, jours: number, palier: string = 'crevette'): string {
  const c = lireCompte(compteId);
  if (!c) return 'Compte inconnu.';
  if (!palierVendu(palier)) {
    return `Palier refusé : « ${palier} » ne se vend pas (${PALIERS_VENDUS.join(', ')}).`;
  }
  const depuis = estAbonne(c) ? new Date(c.abonne_jusqu_a!) : new Date();
  const fin = new Date(depuis.getTime() + jours * 86_400_000).toISOString();
  // ⭐ LES DEUX COLONNES DANS **UN SEUL** `UPDATE`. Deux écritures séparées
  //   laisseraient, entre elles, un instant où la date est prolongée et le
  //   palier encore l'ancien — et si la seconde échoue, l'état reste faux
  //   sans que rien ne le dise.
  run('UPDATE comptes SET abonne_jusqu_a=?, palier=? WHERE id=?', fin, palier, compteId);
  return `Abonné ${palier} jusqu’au ${fin.slice(0, 10)}.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 🔴🔴🔴 LOT 198 — HONORER UN PAIEMENT, UNE SEULE FOIS
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Accorde l'abonnement correspondant à un paiement, en refusant les rejeux.
 *
 * ⭐⭐⭐ POURQUOI CETTE FONCTION EXISTE À CÔTÉ DE `accorderAbonnement()` ET NE
 * LA REMPLACE PAS : le geste d'exploitation (Preda dans `/admin`) et le geste
 * automatique (une notification de paiement) n'ont PAS le même risque. Un
 * humain qui clique deux fois le voit ; un prestataire qui rejoue sa
 * notification ne le voit pas, et c'est NORMAL qu'il rejoue — s'il n'a pas
 * reçu notre réponse, il rappelle. C'est même sa garantie de fiabilité.
 * ⇒ Sans garde, un incident réseau offre six mois à qui a payé un mois.
 *
 * ⛔ ON N'INTERROGE PAS LA BASE AVANT D'ÉCRIRE. La version naïve — « existe-t-il
 *    déjà cette référence ? sinon, accorde » — laisse passer deux notifications
 *    SIMULTANÉES : les deux lisent « non », les deux créditent. C'est l'INSERT
 *    qui refuse, en une seule opération indivisible, parce que `reference` est
 *    la clé primaire. *Une vérification suivie d'une écriture n'est pas
 *    atomique ; une écriture qui échoue, si.*
 *
 * ⭐ ET L'ORDRE EST DÉLIBÉRÉ : on inscrit le paiement AVANT d'accorder. Si le
 *   service s'arrête entre les deux, la personne n'a pas son abonnement mais le
 *   rejeu du prestataire sera refusé — on aura pris l'argent sans ouvrir la
 *   porte, ce qui se répare en un clic depuis `/admin`. L'ordre inverse
 *   accorderait sans trace, et CHAQUE rejeu rajouterait un mois : une panne
 *   invisible qui grossit toute seule. *Entre deux pannes, on choisit celle qui
 *   se voit et qui se répare.*
 *
 * @param reference l'identifiant du paiement chez le prestataire — opaque ici
 * @returns `{ ok, message, rejeu }` — `rejeu: true` n'est PAS une erreur
 */
export function honorerPaiement(
  reference: string, compteId: string, jours: number, palier: string,
): { ok: boolean; message: string; rejeu: boolean } {
  const ref = String(reference ?? '').trim();
  // ⛔ Une référence vide n'est pas une référence : elle rendrait TOUS les
  //    paiements identiques, donc tous les seconds refusés comme des rejeux.
  if (!ref || ref.length > 200) {
    return { ok: false, message: 'Référence de paiement absente ou trop longue.', rejeu: false };
  }
  if (!palierVendu(palier)) {
    return { ok: false, message: `Palier refusé : « ${palier} » ne se vend pas.`, rejeu: false };
  }
  if (!Number.isInteger(jours) || jours < 1 || jours > 400) {
    return { ok: false, message: 'Durée refusée : un entier de 1 à 400 jours.', rejeu: false };
  }
  // ⭐ Le compte est vérifié ICI, avant d'inscrire quoi que ce soit : inscrire
  //   un paiement pour un compte inconnu créerait une référence consommée que
  //   plus rien ne pourrait honorer, même après correction.
  if (!lireCompte(compteId)) return { ok: false, message: 'Compte inconnu.', rejeu: false };

  try {
    run('INSERT INTO paiements (reference, compte_id, jours, palier, ts) VALUES (?,?,?,?,?)',
      ref, compteId, jours, palier, now());
  } catch {
    // ⭐ UN REJEU N'EST PAS UNE ERREUR, et la réponse doit le dire clairement :
    //   un prestataire qui reçoit une erreur RÉESSAIE, indéfiniment. On répond
    //   « c'est déjà fait », il arrête. ⛔ Répondre « erreur » ici fabriquerait
    //   la boucle qu'on cherche à éviter.
    const d = q1<{ jours: number; palier: string }>(
      'SELECT jours, palier FROM paiements WHERE reference=?', ref);
    return {
      ok: true, rejeu: true,
      message: d ? `Paiement déjà honoré (${d.palier}, ${d.jours} j).` : 'Paiement déjà honoré.',
    };
  }
  return { ok: true, rejeu: false, message: accorderAbonnement(compteId, jours, palier) };
}

/** Le jeu note son passage — utile au support, à rien d'autre. */
export const noterAcces = (compteId: string, jeu: string) =>
  run('INSERT INTO acces (compte_id, jeu, ts) VALUES (?,?,?)', compteId, jeu, now());

// ═════════════════════════════════════════════════════════════════════════
// 🔴 La suppression de compte
// ═════════════════════════════════════════════════════════════════════════

/**
 * ⚠️ DÉLAI DE GRÂCE DE SEPT JOURS, ET C'EST UN CHOIX.
 *
 * Une suppression immédiate est irréversible : un clic de trop, et des
 * mois de codex disparaissent. Un délai laisse revenir — et il ne coûte
 * rien à personne, puisque le compte est déjà inaccessible pendant ce
 * temps.
 *
 * ⛔ ET UNE CHOSE QUE LA SUPPRESSION NE FAIT PAS : effacer les héros et
 *    les codex dans les jeux. Ceux-là appartiennent au COLLECTIBLE, pas au
 *    compte. Le jour où quelqu'un rachète le mint, il doit retrouver ce
 *    que le mint sait. Chaque jeu efface ce qui lui appartient — la carte,
 *    le camp — et détache le reste.
 */
export const DELAI_GRACE_JOURS = 7;

export function demanderSuppression(compteId: string): { ok: boolean; message: string } {
  const c = lireCompte(compteId);
  if (!c) return { ok: false, message: 'Compte inconnu.' };
  if (c.supprime_le) return { ok: false, message: 'La suppression est déjà demandée.' };
  run('UPDATE comptes SET supprime_le=? WHERE id=?', now(), compteId);
  return {
    ok: true,
    message: `Suppression demandée. Vous avez ${DELAI_GRACE_JOURS} jours pour revenir sur votre décision — après quoi tout sera effacé.`,
  };
}

export function annulerSuppression(compteId: string): { ok: boolean; message: string } {
  const c = lireCompte(compteId);
  if (!c?.supprime_le) return { ok: false, message: 'Aucune suppression en cours.' };
  run('UPDATE comptes SET supprime_le=NULL WHERE id=?', compteId);
  return { ok: true, message: 'Suppression annulée. Votre compte est intact.' };
}

/** Les comptes dont le délai est écoulé — à effacer pour de bon. */
export const aEffacer = () => q<{ id: string }>(
  'SELECT id FROM comptes WHERE supprime_le IS NOT NULL AND supprime_le < ?',
  new Date(Date.now() - DELAI_GRACE_JOURS * 86_400_000).toISOString());

export function effacerDefinitivement(compteId: string): void {
  run('DELETE FROM avoirs WHERE compte_id=?', compteId);
  run('DELETE FROM acces WHERE compte_id=?', compteId);
  run('DELETE FROM sync_log WHERE compte_id=?', compteId);
  run('DELETE FROM defis WHERE compte_id=?', compteId);
  run('DELETE FROM comptes WHERE id=?', compteId);
}

/** Le ménage, appelé par le planificateur. */
export function purgerComptes(): number {
  let n = 0;
  for (const c of aEffacer()) { effacerDefinitivement(c.id); n++; }
  return n;
}
