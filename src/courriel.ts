/**
 * ⭐⭐ L'ENVOI DE COURRIEL — par l'API HTTP de Brevo, pas par SMTP.
 *
 * 🔴 POURQUOI L'API ET PAS SMTP. Trois raisons, dans l'ordre :
 *
 *  1. **AUCUNE DÉPENDANCE.** Ce dépôt n'en a pas une seule : `package.json`
 *     n'a pas de champ `dependencies`, tout vient de `node:`. SMTP
 *     imposerait `nodemailer`, donc un `npm install` dans le Dockerfile,
 *     donc un arbre de dépendances à surveiller — pour envoyer un message
 *     de quinze lignes.
 *  2. **UN PORT SORTANT NE SE DEMANDE PAS À UN HÉBERGEUR.** Le 587 peut
 *     être fermé côté Coolify sans que personne l'ait décidé ; le 443 ne
 *     l'est jamais.
 *  3. **UNE ERREUR SMTP EST UN CODE À TROIS CHIFFRES.** Brevo rend un JSON
 *     qui nomme le problème (« expéditeur non vérifié », « clé invalide »),
 *     et c'est cette phrase qu'on veut dans le journal à 23 h.
 *
 * ⚠️ BREVO REND 201, PAS 200. Un contrôle `res.ok` suffit, mais un
 *    contrôle `res.status === 200` aurait déclaré en échec tous les envois
 *    réussis — et le service aurait redemandé un lien à l'infini.
 */

const CLE = () => process.env.BREVO_CLE ?? '';

/**
 * ⭐ Preda a choisi `noreply@`, en connaissance de cause. La contrepartie
 *    est réelle : le seul courriel que reçoive un nouvel inscrit est celui
 *    auquel il ne peut pas répondre. `BREVO_REPONSE_A` permet de rendre la
 *    réponse possible sans changer l'expéditeur — pose-la le jour où une
 *    boîte humaine existe.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 🔴🔴 LE DÉFAUT ÉTAIT `noreply@mail.veveprice.com`, ET IL ÉTAIT FAUX.
 * ═══════════════════════════════════════════════════════════════════════
 * `mail.veveprice.com` n'est pas un domaine d'ENVOI : c'est le
 * **Return-Path** de `veveprice.com`, le sous-domaine que Brevo demande de
 * déléguer pour signer les rebonds. Le domaine authentifié — celui qui
 * porte les DKIM `brevo1` et `brevo2` — est `veveprice.com` tout court.
 *
 * ⭐⭐⭐ UN DÉFAUT FAUX EST PIRE QU'UNE VARIABLE OBLIGATOIRE : il fait
 * marcher le service assez pour qu'on le croie configuré. Aujourd'hui
 * `BREVO_EXPEDITEUR` est posée dans Coolify, donc tout fonctionne, et
 * personne ne verrait rien. Le jour d'un redéploiement ailleurs — un
 * second environnement, une restauration, un `veveid` cloné pour un autre
 * site — l'envoi partirait d'une adresse que Brevo refuse : la page dirait
 * « vérifiez vos e-mails » (elle est identique dans tous les cas, exprès)
 * et rien ne partirait jamais.
 * ⭐ La règle qu'on en tire : un défaut de code doit être la valeur qu'on
 * VOUDRAIT si la variable manquait, jamais celle qu'on avait sous les yeux
 * en écrivant la ligne.
 *
 * ⚠️ L'expéditeur DOIT être sur un domaine authentifié chez Brevo. Une
 *    adresse hors de ce domaine est refusée par l'API — 400, pas
 *    silencieusement. `annoncerDemarrage()` AFFICHE désormais l'adresse
 *    réellement utilisée, et d'où elle vient : sans ça, le seul moyen de
 *    savoir laquelle partait était de faire un envoi et de le regarder
 *    échouer.
 */
export const EXPEDITEUR_DEFAUT = 'noreply@veveprice.com';
export const expediteur = () => process.env.BREVO_EXPEDITEUR ?? EXPEDITEUR_DEFAUT;
export const nomExpediteur = () => process.env.BREVO_NOM ?? 'VeVePrice';
const reponseA = () => process.env.BREVO_REPONSE_A ?? '';

/**
 * Le mode simulation. ⛔ IL NE S'ACTIVE PAS TOUT SEUL.
 *
 * 🔴 La tentation était d'écrire « si la clé est absente, on journalise le
 *    lien au lieu de l'envoyer » — pratique en développement. Ce serait un
 *    REPLI QUI OUVRE : le jour où la variable Coolify est mal orthographiée
 *    en production, le service continuerait de marcher, et chaque lien de
 *    connexion s'écrirait en clair dans un journal que plusieurs personnes
 *    peuvent lire. Une panne se répare ; une fuite silencieuse, non.
 *
 * Le repli doit donc être DEMANDÉ : `COURRIEL_SIMULE=1`. Sans clé et sans
 * cette variable, on échoue — franchement, et en le disant.
 */
const simule = () => process.env.COURRIEL_SIMULE === '1';

export interface Envoi { ok: boolean; id?: string; pourquoi?: string; simule?: boolean }

/**
 * ⭐⭐⭐ LA TRACE DU DERNIER ENVOI — et ce que son absence a coûté.
 *
 * Le 06/08, un envoi refusé par Brevo (« unrecognised IP address ») n'était
 * lisible QUE dans le journal du conteneur. De l'extérieur, la page disait
 * « vérifiez vos e-mails » — exactement comme un succès, et c'est voulu.
 * Il a fallu ouvrir Coolify, trouver le bon onglet, et savoir quoi chercher.
 *
 * ⭐ Une trace en mémoire suffit : c'est le DERNIER état qui intéresse, pas
 *    l'historique. Elle disparaît au redémarrage, et c'est très bien — un
 *    échec d'avant le redéploiement ne dit rien de l'installation d'après.
 *
 * ⛔ ON NE GARDE JAMAIS L'ADRESSE DU DESTINATAIRE. Ni ici, ni dans ce qui est
 *    exposé. La question est « l'envoi part-il ? », pas « à qui ».
 */
export interface Trace { quand: string; ok: boolean; pourquoi?: string; simule?: boolean }
let _dernier: Trace | null = null;
export const dernierEnvoi = (): Trace | null => _dernier;
/** Réservé aux tests. */
export const oublierDernierEnvoi = () => { _dernier = null; };

/**
 * ⚠️ CE QUI EST MASQUÉ, ET POURQUOI CHAQUE MOTIF EST LÀ.
 *   · les adresses e-mail : un message d'erreur de Brevo peut citer le
 *     destinataire, et cette trace est exposée publiquement ;
 *   · les clés `xkeysib-…` : par principe, jamais dans une réponse HTTP ;
 *   · la longueur : un message immense servi sur une route publique est une
 *     surface d'attaque gratuite.
 * ⭐ L'adresse IP du serveur n'est PAS masquée : elle est publique par nature
 *   (c'est celle qui répond au DNS), et c'est précisément l'information qui a
 *   permis de corriger la liste blanche de Brevo en une minute.
 */
const masquer = (t: string) => String(t ?? '')
  .replace(/[\w.+-]+@[\w.-]+\.\w{2,}/g, '***@***')
  .replace(/xkeysib-[\w-]+/gi, 'xkeysib-***')
  .slice(0, 300);

const noter = (e: Envoi): Envoi => {
  _dernier = { quand: new Date().toISOString(), ok: e.ok, simule: e.simule,
    ...(e.pourquoi ? { pourquoi: masquer(e.pourquoi) } : {}) };
  return e;
};

export interface Message { a: string; sujet: string; texte: string; html: string }

/**
 * 🔴 CETTE FONCTION NE LÈVE JAMAIS. Elle est appelée depuis une route HTTP
 *    qui doit répondre la MÊME chose que l'envoi ait réussi ou non (voir
 *    `server.ts`, route /inscription) : une exception qui remonterait
 *    changerait la page rendue, et cette différence dirait au visiteur si
 *    l'adresse existe déjà. On rend donc toujours un verdict.
 */
export async function envoyer(m: Message, fetchImpl: typeof fetch = fetch): Promise<Envoi> {
  if (simule()) {
    console.log(`[courriel] SIMULÉ → ${m.a} — « ${m.sujet} »`);
    console.log(`[courriel] SIMULÉ, corps :\n${m.texte}`);
    return noter({ ok: true, simule: true });
  }
  if (!CLE()) return noter({ ok: false, pourquoi: 'BREVO_CLE absente : aucun courriel ne peut partir' });

  try {
    const res = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': CLE(),
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { name: nomExpediteur(), email: expediteur() },
        to: [{ email: m.a }],
        ...(reponseA() ? { replyTo: { email: reponseA() } } : {}),
        subject: m.sujet,
        textContent: m.texte,
        htmlContent: m.html,
      }),
      // ⚠️ Sans délai maximum, une API muette retient la requête HTTP du
      //    visiteur jusqu'au bout du timeout du système — soit deux
      //    minutes de page blanche.
      signal: AbortSignal.timeout(10_000),
    });
    const brut = await res.text();
    if (!res.ok) {
      // On garde la phrase de Brevo : c'est elle qui nomme le vrai défaut.
      return noter({ ok: false, pourquoi: `Brevo ${res.status} : ${brut.slice(0, 300)}` });
    }
    let id: string | undefined;
    try { id = JSON.parse(brut)?.messageId; } catch { /* 201 sans corps lisible : ce n'est pas un échec */ }
    return noter({ ok: true, id });
  } catch (e) {
    return noter({ ok: false, pourquoi: `Brevo injoignable : ${(e as Error).message}` });
  }
}

// ── Le courriel de connexion ───────────────────────────────────────────

/**
 * ⚠️ TEXTE **ET** HTML. Un message qui n'a que du HTML part avec un
 *    mauvais score de réputation, et certains clients n'affichent que le
 *    texte. Le lien doit être lisible et cliquable dans les deux.
 *
 * ⭐ Le lien apparaît EN CLAIR dans la version texte. C'est voulu : un
 *    client qui n'affiche pas le HTML laisserait sinon la personne devant
 *    un message sans porte.
 */
export function courrielDeConnexion(a: string, lien: string, minutes: number, nouveau: boolean): Message {
  const titre = nouveau ? 'Bienvenue — votre lien de connexion' : 'Votre lien de connexion';
  const texte = [
    nouveau ? 'Bienvenue sur VeVePrice.' : 'Vous avez demandé à vous connecter.',
    '',
    'Ouvrez ce lien pour entrer :',
    lien,
    '',
    `Il est valable ${minutes} minutes et ne fonctionne qu'une seule fois.`,
    '',
    "Si vous n'avez rien demandé, ignorez ce message : personne ne peut entrer sans ce lien.",
  ].join('\n');
  const html = enveloppe(
    `<p style="margin:0 0 6px;font:700 17px/1.35 ${POLICE};color:${ENCRE}">`
    + `${nouveau ? 'Bienvenue sur VeVePrice' : 'Votre lien de connexion'}</p>`
    + `<p style="margin:0 0 14px;color:${ENCRE_2}">`
    + `Ouvrez ce lien pour entrer. Il est valable <b style="color:${ENCRE}">${minutes} minutes</b>`
    + ` et ne fonctionne qu'une seule fois.</p>`
    + bouton(lien, 'Entrer sur VeVePrice')
    + `<p style="margin:0 0 14px;font-size:12px;color:${ENCRE_2}">`
    + `Si le bouton ne fonctionne pas, copiez cette adresse :<br>`
    + `<span style="word-break:break-all;color:${LIEN}">${echapperAttribut(lien)}</span></p>`
    + `<p style="margin:0;font-size:12px;color:${ENCRE_2}">`
    + `Si vous n'avez rien demandé, ignorez ce message : personne ne peut entrer sans ce lien.</p>`,
  );
  return { a, sujet: titre, texte, html };
}

/**
 * ⚠️ Le lien est fabriqué par NOUS, mais il contient un jeton en base64url
 *    et une adresse lue dans une variable d'environnement. On échappe
 *    quand même : le jour où un paramètre viendra d'ailleurs, la protection
 *    sera déjà là plutôt qu'à écrire.
 */
/**
 * ⚠️ VeVePreda/veveid — L'ENVELOPPE DES COURRIELS  (LOT J, 07/09/2026)
 * ═══════════════════════════════════════════════════════════════════════════
 * LA CHARTE DE VEVEPRICE, DANS LA SEULE SURFACE DU PROJET OÙ « VALEUR EN DUR »
 * EST LA BONNE RÉPONSE.
 *
 * 🔴 CE QUI A CHANGÉ, ET POURQUOI. Les deux courriels partaient en `#14161b`
 * (un anthracite bleuté) avec un bouton OR `#c9a227` — une charte qui n'est
 * celle d'aucun des deux sites. Un message est souvent le PREMIER objet de la
 * marque qu'une personne voit ; il ne peut pas être le seul à parler une autre
 * langue visuelle.
 *
 * ⛔⛔ ET LE CYAN DE LA MARQUE EST INTERDIT SUR FOND CLAIR. `#10CEF2` sur
 * blanc mesure **1,38:1** — illisible, et pas « presque » : c'est quatre fois
 * moins que le minimum. C'est `#0B798F` qui sert dès qu'il y a du clair
 * dessous (5,1:1 en texte, 5,3:1 en fond sous du blanc). Le cyan garde
 * l'en-tête sombre, où il est à sa place.
 *
 * ⛔ PAS DE VARIABLES CSS, PAS DE `flex`, PAS DE POLICE AUTO-HÉBERGÉE — un
 * client mail n'en garantit aucun. Des `<table>`, des valeurs en dur et des
 * polices système. ⚠️ C'est la seule surface du projet où cette phrase est
 * vraie : partout ailleurs, une valeur en dur est un défaut.
 *
 * ⛔ ET AUCUNE IMAGE. Pas de Floora ici : la table `POSE_DE` (côté veve-sites)
 * n'assigne AUCUNE pose au lien de connexion ni au rappel — lui en inventer
 * une serait le premier pas vers « on met celle qui va bien » — et une image
 * distante est bloquée par défaut chez la moitié des clients mail. Le
 * mot-marque est donc dessiné en HTML, pas chargé.
 *
 * ⛔ NON MESURÉ, ET IL FAUT LE DIRE : le rendu réel dans Outlook, Gmail et
 * Apple Mail. Ce fichier respecte les contraintes connues de ces clients ; il
 * n'a été vu dans aucun.
 */
const NOIR = '#1A1A1A';
const CYAN = '#10CEF2';
const PAPIER = '#F4F4F2';
const ENCRE = '#1A1A1A';
const ENCRE_2 = '#4A4A4A';
const ENCRE_3 = '#6A6A6A';
const LIEN = '#0B798F';
const POLICE = "Arial, Helvetica, sans-serif";

/** Le pied légal, identique aux deux messages : ⛔ il ne se recopie pas. */
const PIED = `Aucun wallet n'est connecté, aucune clé n'est demandée.<br>`
  + `Ceci n'est pas un conseil financier. Non affilié à VeVe / ECOMI.`;

/** Le bouton d'action. ⭐ Un `<a>` dans une `<td>` : Outlook ignore le
 *  `border-radius` mais garde le fond et le rembourrage — le bouton reste un
 *  bouton, seulement carré. C'est la dégradation qu'on accepte. */
const bouton = (lien: string, libelle: string) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px">`
  + `<tr><td style="background:${LIEN};border-radius:999px">`
  + `<a href="${echapperAttribut(lien)}" style="display:inline-block;padding:12px 24px;`
  + `font:700 13.5px/1.2 ${POLICE};color:#FFFFFF;text-decoration:none">${libelle}</a>`
  + `</td></tr></table>`;

/** L'enveloppe complète : l'en-tête de marque, le corps, le pied légal. */
function enveloppe(corps: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"></head>`
    + `<body style="margin:0;padding:0;background:${PAPIER}">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"`
    + ` style="background:${PAPIER}"><tr><td align="center" style="padding:0">`
    + `<table role="presentation" width="420" cellpadding="0" cellspacing="0" border="0"`
    + ` style="width:420px;max-width:100%">`
    // ── l'en-tête sombre : la seule place du cyan
    + `<tr><td style="background:${NOIR};padding:16px 22px">`
    + `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>`
    + `<td style="background:${CYAN};color:${NOIR};width:26px;height:26px;border-radius:7px;`
    + `text-align:center;font:800 11px/26px ${POLICE}">VP</td>`
    + `<td style="padding-left:10px;font:800 14px/1.2 ${POLICE};letter-spacing:.06em;`
    + `color:#FFFFFF">VEVE PRICE</td>`
    + `</tr></table></td></tr>`
    // ── le corps clair
    + `<tr><td style="padding:22px;font:14px/1.6 ${POLICE};color:${ENCRE}">${corps}`
    + `<p style="margin:14px 0 0;font:11.5px/1.6 ${POLICE};color:${ENCRE_3}">${PIED}</p>`
    + `</td></tr></table></td></tr></table></body></html>`;
}

const echapperAttribut = (s: string) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * 🔔 LOT 201 — LE RAPPEL AVANT EXPIRATION.
 *
 * ⭐⭐⭐ IL NE FAIT PAS PEUR, ET C'EST UNE DÉCISION. « Votre accès va être
 * coupé » est vrai et hostile ; la personne a payé, elle n'a rien fait de mal,
 * et son accès ne se coupe pas — il arrive au bout. Le courriel dit la date,
 * dit ce qui reste ouvert après (le compte gratuit, les favoris), et donne un
 * lien. ⛔ Aucun compte à rebours, aucune urgence fabriquée.
 *
 * ⚠️ IL NE PROMET PAS DE RECONDUCTION AUTOMATIQUE, parce qu'il n'y en a pas :
 * la caisse encaisse un virement, elle ne prélève rien. Le dire clairement
 * ici évite la seule mauvaise surprise possible — croire que c'est reconduit.
 *
 * ⛔ ET IL N'Y A AUCUN LIEN DE DÉSABONNEMENT. Ce n'est pas une lettre
 * d'information : c'est un message de service sur un abonnement en cours, au
 * même titre qu'un lien de connexion. Un lien de désinscription y ferait
 * croire qu'on peut refuser d'être prévenu de la fin de ce qu'on a payé.
 */
export function courrielDeRappel(a: string, jours: number, finISO: string, lien: string): Message {
  // ⚠️ La date se rend en clair, dans la langue du service (français) : un
  //    horodatage ISO au milieu d'une phrase ne se lit pas.
  const date = finISO.slice(0, 10).split('-').reverse().join('/');
  const combien = jours <= 1 ? 'demain' : `dans ${jours} jours`;
  const sujet = `Votre accès VeVePrice se termine ${combien}`;
  const texte = [
    `Votre accès VeVePrice se termine ${combien}, le ${date}.`,
    '',
    "Il ne se reconduit pas tout seul : nous n'avons aucun prélèvement en place.",
    'Pour prolonger, tout se passe sur votre compte :',
    lien,
    '',
    'Après cette date, votre compte reste ouvert et vos favoris sont conservés.',
    'Seules les données réservées aux abonnés se referment.',
  ].join('\n');
  const html = enveloppe(
    `<p style="margin:0 0 6px;font:700 17px/1.35 ${POLICE};color:${ENCRE}">`
    + `Votre accès se termine ${combien}</p>`
    + `<p style="margin:0 0 14px;color:${ENCRE_2}">`
    + `Il prend fin le <b style="color:${ENCRE}">${date}</b>, et il ne se reconduit pas tout seul :`
    + ` nous n'avons aucun prélèvement en place.</p>`
    + bouton(lien, 'Prolonger mon accès')
    + `<p style="margin:0 0 14px;font-size:12px;color:${ENCRE_2}">`
    + `Si le bouton ne fonctionne pas, copiez cette adresse :<br>`
    + `<span style="word-break:break-all;color:${LIEN}">${echapperAttribut(lien)}</span></p>`
    + `<p style="margin:0;font-size:12px;color:${ENCRE_2}">`
    + `Après cette date, votre compte reste ouvert et vos favoris sont conservés.`
    + ` Seules les données réservées aux abonnés se referment.</p>`,
  );
  return { a, sujet, texte, html };
}
