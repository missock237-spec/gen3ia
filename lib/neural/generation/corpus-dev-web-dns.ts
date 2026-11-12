/**
 * CORPUS DÉVELOPPEMENT WEB — SOUS-THÈME DNS (it.150).
 *
 * Demande propriétaire : « l'entraîner sur le dev web ET le DNS (domain
 * names system) » — volet DNS COMPLET : hiérarchie (racine, TLD,
 * autoritaires, récursifs), résolution pas à pas, enregistrements
 * A/AAAA/CNAME/MX/NS/TXT/SOA/PTR/CAA/DNSKEY/SRV, TTL et propagation,
 * DNSSEC (chaîne de confiance, KSK/ZSK, NSEC), enregistrements de mise
 * en production (www, apex, SPF/DKIM/DMARC, CAA), erreurs classiques
 * (NXDOMAIN, SERVFAIL), outils de vérification.
 *
 * Deux sources, comptabilisées honnêtement :
 *  - CORPUS_DEV_WEB_DNS_ECRIT : paires RÉDIGÉES (le cœur de qualité —
 *    chaque réponse est une vérité DNS vérifiable) ;
 *  - unités générées déterministes du générateur
 *    lib/gen3/generateur-dev-web-it150.ts (tables de faits + réponses
 *    CALCULÉES : durées de TTL, ordre des priorités MX, chemins de
 *    résolution).
 *
 * Module PUR — aucune dépendance Node.
 */

import type { PaireLangage } from "./corpus";
import {
  unitesFamilleDevWeb,
  type UniteDevWeb,
} from "../../gen3/generateur-dev-web-it150";

const THEME = "developpement-web:dns";

const ECRIRE = (
  motif: string,
  reponse: string,
): PaireLangage => ({ motif, reponse, theme: THEME });

export const CORPUS_DEV_WEB_DNS_ECRIT: readonly PaireLangage[] = [
  // ─── Hiérarchie et acteurs ──────────────────────────────────────────────
  ECRIRE(
    "Explique-moi la hiérarchie du DNS : racine, TLD, serveurs autoritaires et récursifs.",
    "Arbre inversé : la racine « . » en haut (13 serveurs logiques a–m.root-servers.net, anycast) ; en dessous les TLD (.org, .fr — gérés par des registres) ; puis les domaines délégués, servis par des serveurs AUTORITAIRES. Le RÉCURSIF (FAI, 1.1.1.1, 8.8.8.8) fait tout le travail pour votre stub et met en cache selon les TTL.",
  ),
  ECRIRE(
    "Quelle est la différence entre un serveur DNS autoritaire et un résolveur récursif ?",
    "L'autoritaire DÉTIENT une zone et répond avec ses données (ou NXDOMAIN) — il ne cherche pas ailleurs. Le récursif ne détient rien : il interroge racine → TLD → autoritaires pour son client, met en cache selon les TTL. Vous parlez au récursif ; les autoritaires parlent au récursif.",
  ),
  ECRIRE(
    "Combien de serveurs racine existent et comment fonctionnent-ils ?",
    "13 adresses logiques (a.root-servers.net → m.root-servers.net) — mais chaque lettre est anycast : des centaines de sites servent le même IP partout dans le monde. La zone racine contient les délégations NS de tous les TLD.",
  ),
  ECRIRE(
    "C'est quoi la différence entre récursif et itératif en DNS ?",
    "RÉCURSIF : « fais tout le travail et rends-moi la réponse finale ». ITÉRATIF : « réponds ce que tu sais, sinon donne une référence à suivre ». Les serveurs racine et TLD répondent itérativement (références NS) ; votre résolveur récursif suit la chaîne pour vous.",
  ),
  ECRIRE(
    "Qu'est-ce qu'une zone DNS, par différence avec un domaine ?",
    "Le DOMAINE est un sous-arbre de noms ; la ZONE est la portion du domaine administrée par un jeu de serveurs autoritaires (le fichier de zone), délimitée par les délégations NS. Un domaine peut contenir plusieurs zones déléguées ; une zone commence par un SOA.",
  ),
  ECRIRE(
    "À quoi servent les enregistrements NS et les glue records ?",
    "Les NS délèguent : le parent pointe les serveurs autoritaires de l'enfant. Le GLUE est l'adresse (A/AAAA) que le parent publie pour un NS DONT le nom est sous le domaine délégué (ns1.exemple.org dans la zone exemple.org) — sans glue, l'amorçage boucle : impossible de résoudre le serveur qui sert la zone.",
  ),
  ECRIRE(
    "Quel port et quel protocole utilise le DNS ?",
    "Port 53. UDP pour les requêtes usuelles (léger, rapide) ; TCP quand la réponse est grande (enregistrements DNSSEC, troncature), pour les transferts de zone (AXFR) et comme repli. Ajoutez DoH (HTTPS/443) et DoT (TLS/853) pour le chiffrement du transport.",
  ),
  ECRIRE(
    "Qu'est-ce que l'anycast DNS et pourquoi est-ce utilisé ?",
    "Une même adresse IP annoncée depuis des centaines de sites : le routage amène chaque client au site le plus proche. Résilience (la mort d'un site est absorbée), latence réduite — c'est le modèle des serveurs racine et des résolveurs publics.",
  ),
  ECRIRE(
    "Quelle différence entre un registrar et un registre DNS ?",
    "Le REGISTRE (ex. Verisign pour .com, AFNIC pour .fr) tient la zone du TLD et l'infrastructure. Le REGISTRAR (ex. un revendeur) vend l'enregistrement du domaine et publie vos données (notamment la DS DNSSEC et les NS) au registre. Votre fichier de zone, lui, vit chez votre hébergeur DNS.",
  ),
  ECRIRE(
    "Qu'est-ce qu'un résolveur stub ?",
    "Le tout petit client DNS de l'OS (le pilote système) : il ne sait pas résoudre récursivement, il envoie chaque question au résolveur récursif configuré (DHCP/VPN) et met parfois en cache localement. dig part du stub ; dig @ip contourne le stub.",
  ),
  // ─── Résolution pas à pas ───────────────────────────────────────────────
  ECRIRE(
    "Décris la résolution DNS complète de www.exemple.org du cache du navigateur jusqu'à la réponse.",
    "1) cache navigateur puis OS (stub) ; 2) question au résolveur récursif — réponse si cache encore frais (TTL) ; 3) sinon le récursif interroge une RACINE → référence vers .org ; 4) un serveur .org → référence vers les NS autoritaires d'exemple.org (+ glue) ; 5) l'autoritaire répond www A 203.0.113.10 TTL 3600 ; 6) le récursif met en cache et rend la réponse. Chaque étape stocke sa réponse pendant le TTL.",
  ),
  ECRIRE(
    "Que renvoie une racine DNS quand on lui demande www.exemple.org ?",
    "Elle ne connaît pas www.exemple.org : elle répond par une RÉFÉRENCE — la liste NS des serveurs du TLD .org (avec le glue). C'est une réponse itérative : au récursif de continuer vers le TLD puis l'autoritaire du domaine.",
  ),
  ECRIRE(
    "Comment le résolveur choisit-il entre cache et requête autoritaire ?",
    "Si le cache contient la réponse avec un TTL non expiré → il répond tout de suite (TTL affiché décroissant). Sinon il résout depuis la racine. Un TTL à 0 (ou très court) force la fraîcheur ; un TTL long augmente le risque de servir une valeur périmée après un changement.",
  ),
  ECRIRE(
    "Qu'est-ce que le DNS fait quand plusieurs enregistrements A existent pour un même nom ?",
    "Il renvoie le RRset complet (toutes les A) ; le client (résolveur ou application) répartit : rotation ordre aléatoire/round-robin, géolocalisation côté DNS dynamique, priorité uniquement pour MX/SRV. Plusieurs A = équilibrage simple et redondance.",
  ),
  ECRIRE(
    "Le TTL est-il renvoyé inchangé quand la réponse vient d'un cache ?",
    "Non : le résolveur cache DÉCRÉMENTE le TTL à chaque lecture — le TTL affiché diminue jusqu'à 0, preuve que la réponse vient d'un cache et non de l'autoritaire. Interroger l'AUTORITAIRE (@ns1...) donne le TTL complet d'origine.",
  ),
  ECRIRE(
    "Qu'est-ce que la récursion fermée (recursion refused) sur un serveur DNS ?",
    "Un serveur AUTORITAIRE ne doit pas faire la récursion pour tout le monde : sans ACL, il devient une cible d'amplification DDoS. Bien configuré, il répond REFUSED aux requêtes récursives des inconnus — c'est un comportement sain, pas une panne.",
  ),
  // ─── Types d'enregistrements ────────────────────────────────────────────
  ECRIRE(
    "À quoi servent les enregistrements A et AAAA ? Quelle différence ?",
    "A : nom → adresse IPv4 (32 bits, ex. 203.0.113.10). AAAA : nom → IPv6 (128 bits, ex. 2001:db8::10). Même nom, les deux en parallèle pour un site dual-stack ; le navigateur utilise Happy Eyeballs pour préférer ce qui marche.",
  ),
  ECRIRE(
    "Pourquoi les enregistrements MX ont-ils une priorité et comment fonctionne-t-elle ?",
    "MX = « le courriel pour ce domaine va à ce serveur ». Le champ priorité (0–65535) : le PLUS PETIT d'abord ; en cas d'échec, on essaie le suivant croissant. Deux MX à priorité égale répartissent la charge ; un MX à priorité haute est le secours. Le hôte visé doit résoudre en A/AAAA (jamais un CNAME vers le MX).",
  ),
  ECRIRE(
    "Peut-on pointer un enregistrement MX vers un CNAME ?",
    "Non : la RFC interdit que la cible d'un MX soit un CNAME (comme pour les NS). Le MX doit pointer vers un nom qui a des A/AAAA directs. Sinon certains émetteurs refusent le courriel et le diagnostic est confus.",
  ),
  ECRIRE(
    "Que contient un enregistrement SOA et à quoi servent ses champs ?",
    "SOA = début d'autorité : NS primaire, courriel de l'administrateur (point remplacé l'@), SERIAL (incrémenté à chaque modification — pilote les transferts de zone), REFRESH/RETRY/EXPIRE (rythmes des serveurs secondaires), et MINIMUM — devenu le TTL NÉGATIF : durée de mise en cache d'un NXDOMAIN.",
  ),
  ECRIRE(
    "Pourquoi incrémenter le numéro de série du SOA après chaque changement de zone ?",
    "Les serveurs secondaires comparent le SERIAL : plus grand = zone plus récente (arithmétique de série RFC 1982). Sans incrément, ils jugent la zone inchangée et NE TRANSFÈRENT PAS vos modifications — le classique « j'ai changé le DNS mais rien ne bouge sur le secondaire ».",
  ),
  ECRIRE(
    "À quoi servent les enregistrements PTR (rétro-DNS) et où vivent-ils ?",
    "PTR fait l'inverse du A : IP → nom. La zone reverse est 203.0.113.in-addr.arpa (IPv4) ou …ip6.arpa (IPv6), souvent administrée par le fournisseur d'IP. Critique pour le courriel : beaucoup de récepteurs vérifient que le PTR du serveur émetteur correspond à son nom (et au reverse de SPF).",
  ),
  ECRIRE(
    "Que permet l'enregistrement CAA et comment s'écrit-il ?",
    "CAA liste les autorités de certification autorisées à émettre des certificats pour le domaine : exemple.org. IN CAA 0 issue \"letsencrypt.org\" ; add ; wildcard pour les sous-domaines. Les CA sérieuses le vérifient avant émission — un contrôle supplémentaire contre l'émission frauduleuse.",
  ),
  ECRIRE(
    "À quoi sert un enregistrement SRV et comment le lire ?",
    "SRV localise un service : _service._protocole IN SRV PRIORITÉ POIDS PORT CIBLE, ex. _sip._tcp 10 60 5060 sip.exemple.org. Comme MX, priorité la plus basse d'abord, poids répartit entre égaux. Utilisé par SIP, XMPP, Kerberos, la découverte Windows (AD).",
  ),
  ECRIRE(
    "Que sont les enregistrements wildcard (*.exemple.org) et leurs pièges ?",
    "*.exemple.org couvre tout nom de premier niveau non défini : a.exemple.org matche, mais a.b.exemple.org ne matche PAS (wildcard ne couvre qu'un seul label), et un nom explicitement défini gagne toujours sur le wildcard. Utile pour les multi-tenants ; piège : le wildcard masque les typos (tout « résout »).",
  ),
  ECRIRE(
    "Qu'est-ce qu'un enregistrement ALIAS ou ANAME à l'apex ?",
    "Un mécanisme fourni par les hébergeurs DNS (pas une RFC universelle) : au niveau du nom NU, il suit en interne la cible (comme un CNAME) et répond en A/AAAA aplaties — la seule façon propre de mettre un apex sur un CDN/S3 sans A fixe. Sinon : A/AAAA directs, ou CNAME flattening automatique chez certains DNS.",
  ),
  ECRIRE(
    "À quoi servent les enregistrements SVCB et HTTPS ?",
    "SVCB/HTTPS (RFC 9460) : le nom annonce des points de terminaison alternatifs + paramètres de connexion (ALPN, ECH, port) directement dans le DNS. Le navigateur découvre l'alternative AVANT la première connexion — base des connexions optimisées et de l'ech blindage SNI.",
  ),
  // ─── TTL et propagation ─────────────────────────────────────────────────
  ECRIRE(
    "Comment fonctionne le TTL d'un enregistrement DNS ?",
    "TTL (Time To Live) : durée en secondes pendant laquelle une réponse peut être mise en cache — par le résolveur, l'OS, le navigateur. Passé ce délai, on re-interroge l'autoritaire. TTL court (60–300) = changements vite visibles, charge autoritaire plus forte ; TTL long (86400) = charge réduite, changement lent.",
  ),
  ECRIRE(
    "Qu'est-ce que la « propagation DNS » réellement ?",
    "Ce n'est PAS une onde qui traverse le réseau : vos anciennes données vivent dans des CACHES qui expirent à leur TTL. Chaque résolveur du monde re-interroge à SON rythme — « propagation » = fin de vie du cache le plus récent (max = TTL). D'où le rituel : baisser le TTL 24–48 h AVANT un changement.",
  ),
  ECRIRE(
    "Comment réduire la fenêtre de propagation avant une migration DNS ?",
    "1) 24–48 h avant : baisser le TTL des enregistrements concernés à 60–300 s ; 2) attendre un cycle complet de l'ancien TTL ; 3) faire le changement ; 4) vérifier depuis plusieurs résolveurs publics + l'autoritaire ; 5) remonter le TTL après stabilisation. Le TTL NÉGATIF du SOA régit la fin d'un NXDOMAIN.",
  ),
  ECRIRE(
    "Un NXDOMAIN est-il mis en cache ? Combien de temps ?",
    "Oui — cache NÉGATIF : un nom qui n'existe pas est caché selon le champ MINIMUM du SOA (TTL négatif), souvent 1–3 h. Conséquence : un domaine fraîchement créé peut rester « inexistant » pour certains résolveurs même après création, jusqu'à expiration du négatif.",
  ),
  ECRIRE(
    "Le navigateur et l'OS ont-ils leur propre cache DNS ?",
    "Oui : cache OS (stub, minutes selon TTL), cache navigateur (Chrome ~60 s interne), et résolveurs réseau en route. Un dig propre ne voit PAS ces caches — pour tester le chemin complet, vider (ipconfig /flushdns, systemd-resolve --flush-caches) ou utiliser des outils qui court-circuitent.",
  ),
  // ─── Mise en production (www, apex, courriel, TLS) ──────────────────────
  ECRIRE(
    "Quels enregistrements minimum pour mettre un site web en production ?",
    "Apex : A 203.0.113.10 (et AAAA si IPv6). www : CNAME exemple.org. ou son propre A. Certificat : CAA pour borner les CA, _acme-challenge TXT si DNS-01 (Let's Encrypt). Courriel : MX + SPF (TXT) + DKIM (TXT sélecteur) + DMARC (TXT _dmarc). NS : au moins deux serveurs autoritaires ; SOA avec série incrémentée.",
  ),
  ECRIRE(
    "Pourquoi ne peut-on pas mettre un CNAME directement sur exemple.org (apex) ?",
    "L'apex DOIT porter SOA et NS — or un nom qui a un CNAME ne peut avoir AUCUN autre enregistrement (le CNAME remplace tout). Conclusion : CNAME interdit à l'apex (RFC 1034/2181). Solutions : A/AAAA directs, ALIAS/ANAME (aplatit côté DNS), ou CNAME flattening chez l'hébergeur.",
  ),
  ECRIRE(
    "Comment configurer www par rapport à l'apex ?",
    "Deux écoles valides : www en CNAME vers l'apex (un seul point de vérité d'IP) ; ou apex et www en A séparés. Dans tous les cas : les DEUX doivent répondre (301 vers l'un ou l'autre côté serveur), sinon la moitié des utilisateurs échoue. Hors apex, le CNAME est parfaitement légal.",
  ),
  ECRIRE(
    "Quel enregistrement SPF publier pour un domaine qui envoie via un fournisseur ?",
    "TXT : « v=spf1 include:_spf.fournisseur.net -all ». include délègue la liste du fournisseur, -all refuse tout le reste (après validation ~all). Limite : 10 résolutions DNS par message au total — simplifier les include. Un seul SPF par nom : fusionner les mécanismes dans UN TXT.",
  ),
  ECRIRE(
    "Comment publier une clé DKIM ?",
    "TXT au nom SELECTEUR._domainkey.exemple.org (le sélecteur est choisi par votre système d'envoi) : « v=DKIM1; k=rsa; p=MIIBIjANBgkq… » — la clé publique du couple qui signe les messages. Clé 2048 bits recommandée ; un sélecteur par système d'envoi (marketing ≠ transactionnel) pour révoquer indépendamment.",
  ),
  ECRIRE(
    "Quelle politique DMARC commencer et vers quoi converger ?",
    "TXT _dmarc.exemple.org : « v=DMARC1; p=none; rua=mailto:dmarc@exemple.org » d'abord (surveillance, rapports XML) ; quand les rapports montrent un alignement SPF/DKIM propre, passer p=quarantine puis p=reject. DMARC aligne au moins un de SPF/DKIM avec le domaine du From visible.",
  ),
  ECRIRE(
    "Pourquoi mon courriel échoue-t-il alors que SPF, DKIM et DMARC sont publiés ?",
    "Causes fréquentes : plusieurs TXT SPF sur le même nom (SPF « Permerror »), limite de 10 lookups dépassée, DKIM signé par un sélecteur non publié, alignement absent (From exemple.org mais envoi via un domaine tiers sans include), ou MX pointant vers un hôte sans A. Diagnostiquer avec un test d'envoi + les rapports rua.",
  ),
  ECRIRE(
    "Quels enregistrements pour faire valider un certificat via DNS (DNS-01) ?",
    "Let's Encrypt demande un TXT _acme-challenge.exemple.org (ou _acme-challenge.www...) portant le jeton du défi. Automatisable par API du DNS — c'est la méthode qui émet des certificats wildcard (le HTTP-01 ne couvre pas *).",
  ),
  // ─── Erreurs et diagnostic ──────────────────────────────────────────────
  ECRIRE(
    "Quelle différence entre NXDOMAIN et SERVFAIL ?",
    "NXDOMAIN : le nom N'EXISTE PAS — réponse positive d'inexistence (cachable via le TTL négatif du SOA). SERVFAIL : le résolveur N'A PAS réussi — zone cassée, DNSSEC invalide, upstream mort — réponse d'échec (cachable court). NXDOMAIN dit « non » ; SERVFAIL dit « je ne peux pas répondre ».",
  ),
  ECRIRE(
    "Pourquoi un domaine peut-il résoudre chez un fournisseur mais pas chez un autre ?",
    "Caches à des âges différents (TTL), cache négatif d'un NXDOMAIN antérieur à la création, résolveur filtrant (RLP), ou délégation partielle (un NS mort d'un côté). Méthode : interroger l'AUTORITAIRE directement (@ns1... = vérité), puis comparer 8.8.8.8, 1.1.1.1, le FAI — l'écart localise la couche.",
  ),
  ECRIRE(
    "dig dit SERVFAIL sur un domaine signé DNSSEC — quelles causes possibles ?",
    "Signature RRSIG expirée (le rollover n'a pas eu lieu), DS périmée au parent après changement de KSK, algorithme non supporté par le résolveur, ou zone signée avec un registre non aligné. Le résolveur validateur refuse les données invalides → SERVFAIL (c'est DNSSEC qui protège, pas un bug de dig).",
  ),
  ECRIRE(
    "Comment vérifier que mon changement DNS est visible partout ?",
    "1) dig +norecurse @ns1.hébergeur nom — la vérité autoritaire ; 2) dig +trace nom — la chaîne de délégation complète ; 3) dig @8.8.8.8 et @1.1.1.1 et le résolveur du FAI — les caches ; 4) comparer les TTL affichés (décroissants = cache). Plusieurs vantage points/mondes si la géodistribution compte.",
  ),
  ECRIRE(
    "Que vérifier quand « le site est down » mais que le serveur répond ?",
    "Couche DNS d'abord : dig A du nom (NXDOMAIN ? SERVFAIL ? TTL ?), NS toujours délégués au bon hébergeur, domaine pas expiré au registrar (whois), glue correct sur les NS, DNSSEC non cassé. Puis certificat (expiré ? CAA ?), puis HTTP. La moitié des « pannes serveur » sont des pannes DNS.",
  ),
  // ─── DNSSEC ─────────────────────────────────────────────────────────────
  ECRIRE(
    "Pourquoi activer DNSSEC sur un domaine ?",
    "DNSSEC signe cryptographiquement chaque RRset : le résolveur validateur prouve que la réponse vient bien de la zone et n'a pas été altérée — cela tue le cache poisoning (Kaminsky) et le détournement de réponse sur le chemin. Authentification + intégrité : la bonne réponse, pas une réponse forgée.",
  ),
  ECRIRE(
    "DNSSEC chiffre-t-il le DNS ? Protège-t-il la vie privée ?",
    "Non — DNSSEC signe, il ne chiffre pas : le contenu reste lisible sur le réseau. La confidentialité du transport passe par DoT/DoH. Et le domaine reste visible par le resolver de toute façon. DNSSEC = authenticité ; DoH/DoT = confidentialité ; les deux sont complémentaires.",
  ),
  ECRIRE(
    "Comment fonctionne la chaîne de confiance DNSSEC de la racine à mon domaine ?",
    "La racine signe les clés des TLD (DS de .org) ; le TLD signe la DS de votre zone (publiée par votre registrar) ; votre zone signe ses RRsets avec ses DNSKEY. Le résolveur validateur part de la KSK racine connue (trust anchor) et descend : chaque lien DS→DNSKEY est vérifié. Chaîne cassée = SERVFAIL, jamais une réponse non validée.",
  ),
  ECRIRE(
    "Quelle différence entre KSK et ZSK en DNSSEC ?",
    "KSK (Key Signing Key) : signe le RRset DNSKEY seulement — c'est elle dont le parent publie la DS ; rotation rare et délicate. ZSK (Zone Signing Key) : signe tous les autres RRsets (A, MX, TXT…) — rotation fréquente et simple. La séparation limite l'exposition de la KSK (clé « maîtresse »).",
  ),
  ECRIRE(
    "Que sont RRSIG, NSEC et NSEC3 ?",
    "RRSIG : la signature d'un RRset (valide entre inception et expiration — à renouveler avant péremption). NSEC/NSEC3 : chaîne ordonnée des noms de la zone qui PROUVE qu'un nom demandé n'existe pas (déni d'existence authentifié) ; NSEC3 hache les noms pour éviter l'énumération complète de la zone.",
  ),
  ECRIRE(
    "Comment publier DNSSEC sans couper son domaine ?",
    "1) signer la zone (générer KSK+ZSK, activer les signatures) ; 2) tester la validation en interne ; 3) publier la DS chez le registrar (elle pointe la KSK) ; 4) surveiller les résolveurs (un DS faux = SERVFAIL mondial) ; 5) planifier le rollover (prépublication). Sens inverse pour retirer : retirer la DS AVANT de désigner la signature.",
  ),
  ECRIRE(
    "Que signifient les bits DO, AD et CD dans le DNS ?",
    "DO (DNSSEC OK) : le client veut les enregistrements DNSSEC dans la réponse. AD (Authentic Data) : le résolveur a VALIDÉ la chaîne — réponse authentique. CD (Checking Disabled) : le client validera lui-même, le résolveur ne doit pas rejeter. Sur dig : +dnssec pour DO, flag ad dans les en-têtes.",
  ),
  // ─── Outils ─────────────────────────────────────────────────────────────
  ECRIRE(
    "Comment interroger directement un serveur autoritaire avec dig ?",
    "dig +norecurse @ns1.hébergeur.net exemple.org — pas de récursion : la réponse vient du serveur précisé, donc de la source. C'est la VÉRITÉ de la zone (utile pour vérifier un changement sans le voile des caches). Ajoutez +short pour l'épuré, MX/AAAA/TXT pour le type.",
  ),
  ECRIRE(
    "Que fait dig +trace et quand l'utiliser ?",
    "+trace rejoue la résolution complète depuis la racine : racine → TLD → NS délégués → réponse. Il montre OÙ la chaîne se casse (délégation manquante, glue erroné). Plus lent (de vraies requêtes à chaque niveau) mais diagnostique du bout en bout.",
  ),
  ECRIRE(
    "Comment voir le TTL réel d'une réponse DNS ?",
    "dig (sans +short) affiche la section réponse avec les TTL. Via un résolveur cache, le TTL décroît à chaque requête : 3600 → 3543 → 2988… Quand il atteint 0, le résolveur re-résout. Le TTL complet ne réapparaît qu'en interrogeant l'autoritaire.",
  ),
  ECRIRE(
    "DNS over HTTPS et DNS over TLS : à quoi ça sert ?",
    "DoH (HTTPS 443) et DoT (TLS 853) chiffrent le transport stub→résolveur : le réseau local ne voit plus vos questions (confidentialité, anti-triche ISP). Ça ne change PAS les données ni la validation DNSSEC. Résolveurs publics : 1.1.1.1 (DoT 853, DoH cloudflare-dns.com), 8.8.8.8 (dns.google).",
  ),
];

function versPaire(u: UniteDevWeb): PaireLangage {
  return { motif: u.motif, reponse: u.reponse, theme: u.theme };
}

/** Familles générées de ce sous-thème — chaque unité est un fait DNS réel
 * avec réponse précise (réponses ARITHMÉTIQUES calculées pour TTL/MX). */
const FAMILLES_DNS = [
  "types-enregistrements-dns",
  "hierarchie-dns",
  "resolution-pas-a-pas",
  "zone-production",
  "ttl-duree",
  "ttl-horloge",
  "mx-priorites",
  "erreurs-dns",
  "dnssec-faits",
  "spf-dkim-dmarc",
  "outils-dns",
] as const;

function genereFamilles(): readonly PaireLangage[] {
  const sorties: PaireLangage[] = [];
  for (const fam of FAMILLES_DNS) {
    for (const u of unitesFamilleDevWeb(fam, 10_000)) {
      sorties.push(versPaire(u));
    }
  }
  return sorties;
}

export const CORPUS_DEV_WEB_DNS_GENERE: readonly PaireLangage[] = genereFamilles();

export const CORPUS_DEV_WEB_DNS: readonly PaireLangage[] = [
  ...CORPUS_DEV_WEB_DNS_ECRIT,
  ...CORPUS_DEV_WEB_DNS_GENERE,
];

export const TAILLE_CORPUS_DEV_WEB_DNS = CORPUS_DEV_WEB_DNS.length;
