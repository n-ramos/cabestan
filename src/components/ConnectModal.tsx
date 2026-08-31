import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { KeyRound } from "lucide-react";
import {
  AuthMethod,
  ConnectOptions,
  HostKeyIssue,
  LocalPubKey,
  SavedConnection,
  credGet,
  localPublicKeys,
  parseHostKeyIssue,
} from "../api";

export interface ConnectMeta {
  name: string;
  save: boolean;
  savePassword: boolean;
  auth: AuthMethod;
  /** Installer cette clé publique sur le serveur au lieu de garder le mot de passe. */
  copyIdKey: LocalPubKey | null;
  group?: string;
  color?: string;
  profile?: string[];
}

interface Props {
  prefill: SavedConnection | null;
  /** "edit" quand on vient de la roue crantée d'une connexion gardée. */
  mode?: "connect" | "edit";
  initialError?: string | null;
  initialHostKey?: HostKeyIssue | null;
  onCancel: () => void;
  onConnect: (opts: ConnectOptions, meta: ConnectMeta) => Promise<void>;
}

export default function ConnectModal({
  prefill,
  mode = "connect",
  initialError = null,
  initialHostKey = null,
  onCancel,
  onConnect,
}: Props) {
  const [name, setName] = useState(prefill?.name ?? "");
  const [host, setHost] = useState(prefill?.host ?? "");
  const [port, setPort] = useState(prefill?.port ?? 22);
  const [username, setUsername] = useState(prefill?.username ?? "");
  const [auth, setAuth] = useState<AuthMethod>(prefill?.auth ?? "password");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState(prefill?.keyPath ?? "");
  const [passphrase, setPassphrase] = useState("");
  const [save, setSave] = useState(true);
  const [group, setGroup] = useState(prefill?.group ?? "");
  const [color, setColor] = useState(prefill?.color ?? "");
  const [jump, setJump] = useState(prefill?.jump ?? "");
  const [profile, setProfile] = useState((prefill?.profile ?? []).join("\n"));
  const [savePassword, setSavePassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [hostKey, setHostKey] = useState<HostKeyIssue | null>(initialHostKey);
  const [copyId, setCopyId] = useState(false);
  const [pubKeys, setPubKeys] = useState<LocalPubKey[]>([]);
  const [pubKeyPath, setPubKeyPath] = useState("");

  // Clés publiques locales, candidates à l'installation sur le serveur.
  useEffect(() => {
    localPublicKeys()
      .then((keys) => {
        setPubKeys(keys);
        // Préfère une clé dont la privée est présente (utilisable sans agent).
        const best = keys.find((k) => k.privatePath) ?? keys[0];
        if (best) setPubKeyPath(best.path);
      })
      .catch(() => {});
  }, []);

  const chosenKey = pubKeys.find((k) => k.path === pubKeyPath) ?? null;

  // Pré-remplit le mot de passe depuis le Trousseau pour une connexion gardée.
  useEffect(() => {
    if (prefill && prefill.auth === "password") {
      credGet(prefill.id)
        .then((p) => {
          if (p) {
            setPassword(p);
            setSavePassword(true);
          }
        })
        .catch(() => {});
    }
  }, [prefill]);

  const canSubmit = host.trim() !== "" && username.trim() !== "" && !busy;

  // Empreintes de bastions déjà validées pendant cette tentative.
  const [trustedJumps, setTrustedJumps] = useState<string[]>([]);

  /** true si l'empreinte concerne un bastion et non le serveur cible. */
  const isJumpIssue = (issue: HostKeyIssue) =>
    !!issue.origin && issue.origin !== `${host.trim()}:${port}`;

  const doConnect = async (trustFingerprint?: string, extraJump?: string) => {
    setBusy(true);
    setError(null);
    try {
      await onConnect(
        {
          host: host.trim(),
          port,
          username: username.trim(),
          password: auth === "password" ? password : undefined,
          keyPath: auth === "key" ? keyPath : undefined,
          keyPassphrase: auth === "key" && passphrase ? passphrase : undefined,
          useAgent: auth === "agent",
          jump: jump.trim() || undefined,
          trustFingerprint,
          trustJump: extraJump ? [...trustedJumps, extraJump] : trustedJumps,
        },
        {
          name: name.trim() || `${username.trim()}@${host.trim()}`,
          save,
          savePassword: auth === "password" && save && savePassword && !copyId,
          auth,
          copyIdKey: auth === "password" && copyId ? chosenKey : null,
          group: group.trim() || undefined,
          color: color || undefined,
          profile: profile
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean),
        },
      );
    } catch (err) {
      const issue = parseHostKeyIssue(err);
      if (issue) {
        setHostKey(issue);
      } else {
        setError(String(err));
      }
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setHostKey(null);
    await doConnect();
  };

  const browseKey = async () => {
    const picked = await openDialog({
      title: "Choisir une clé privée",
      defaultPath: `${keyPath || "~/.ssh"}`,
    });
    if (typeof picked === "string") setKeyPath(picked);
  };

  if (hostKey) {
    return (
      <div className="modal-backdrop" onMouseDown={onCancel}>
        <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
          <p className="modal-eyebrow">
            {hostKey.kind === "unknown" ? "Première escale" : "Alerte"}
          </p>
          <h2 className="modal-title">
            {isJumpIssue(hostKey)
              ? hostKey.kind === "unknown"
                ? "Bastion inconnu"
                : "La clé du bastion a changé"
              : hostKey.kind === "unknown"
                ? "Serveur inconnu"
                : "La clé du serveur a changé"}
          </h2>
          {isJumpIssue(hostKey) && (
            <p className="hostkey-text">
              Ce rebond passe par <code>{hostKey.origin}</code>, dont l'empreinte n'est
              pas encore connue.
            </p>
          )}
          {hostKey.kind === "unknown" ? (
            <p className="hostkey-text">
              Ce serveur n'est pas encore dans vos hôtes connus. Vérifiez son empreinte
              avant de continuer — elle sera ensuite mémorisée dans{" "}
              <code>~/.ssh/known_hosts</code>.
            </p>
          ) : (
            <p className="hostkey-text danger">
              L'empreinte reçue ne correspond pas à celle mémorisée pour{" "}
              <code>{hostKey.origin ?? `${host}:${port}`}</code>. Cela peut venir d'une
              réinstallation du serveur… ou d'une attaque de l'homme du milieu. Ne
              continuez que si vous savez pourquoi la clé a changé.
            </p>
          )}
          <div className="hostkey-fp">
            <span className="hostkey-algo">{hostKey.algo}</span>
            <code>{hostKey.fingerprint}</code>
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setHostKey(null)} disabled={busy}>
              Annuler
            </button>
            <button
              className={`btn ${hostKey.kind === "changed" ? "danger-solid" : "primary"}`}
              onClick={() => {
                if (isJumpIssue(hostKey)) {
                  // Empreinte de bastion : on la retient et on relance la chaîne.
                  setTrustedJumps((prev) => [...prev, hostKey.fingerprint]);
                  setHostKey(null);
                  doConnect(undefined, hostKey.fingerprint);
                } else {
                  doConnect(hostKey.fingerprint);
                }
              }}
              disabled={busy}
            >
              {busy
                ? "Connexion…"
                : hostKey.kind === "unknown"
                  ? "Faire confiance et continuer"
                  : "Remplacer la clé et continuer"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <form className="modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <p className="modal-eyebrow">
          {mode === "edit" ? "Connexion gardée" : "Nouvelle escale"}
        </p>
        <h2 className="modal-title">
          {mode === "edit" ? "Modifier la connexion" : "Se connecter à un serveur"}
        </h2>

        <label className="field">
          <span>Nom (facultatif)</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Serveur de prod, NAS maison…"
          />
        </label>

        <div className="field-row">
          <label className="field grow">
            <span>Hôte</span>
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="exemple.fr ou 192.168.1.10"
              autoFocus={!prefill}
              className="mono"
            />
          </label>
          <label className="field port">
            <span>Port</span>
            <input
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(Number(e.target.value) || 22)}
              className="mono"
            />
          </label>
        </div>

        <label className="field">
          <span>Utilisateur</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="root, ubuntu…"
            className="mono"
          />
        </label>

        <div className="auth-switch" role="tablist">
          <button
            type="button"
            className={auth === "password" ? "active" : ""}
            onClick={() => setAuth("password")}
          >
            Mot de passe
          </button>
          <button
            type="button"
            className={auth === "key" ? "active" : ""}
            onClick={() => setAuth("key")}
          >
            Clé SSH
          </button>
          <button
            type="button"
            className={auth === "agent" ? "active" : ""}
            onClick={() => setAuth("agent")}
          >
            Agent
          </button>
        </div>

        {auth === "password" ? (
          <>
            <label className="field">
              <span>Mot de passe</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus={!!prefill}
              />
            </label>

            <label className={`copyid-box ${copyId ? "on" : ""}`}>
              <input
                type="checkbox"
                checked={copyId}
                onChange={(e) => setCopyId(e.target.checked)}
                disabled={pubKeys.length === 0}
              />
              <span>
                <span className="copyid-title">
                  <KeyRound size={13} /> Installer ma clé publique sur le serveur
                </span>
                <small>
                  {pubKeys.length === 0
                    ? "Aucune clé publique dans ~/.ssh — créez-en une avec ssh-keygen."
                    : "Comme ssh-copy-id : le mot de passe sert une seule fois, les connexions suivantes utilisent la clé. Rien à stocker."}
                </small>
              </span>
            </label>

            {copyId && pubKeys.length > 0 && (
              <label className="field">
                <span>Clé à installer</span>
                <select
                  className="mono"
                  value={pubKeyPath}
                  onChange={(e) => setPubKeyPath(e.target.value)}
                >
                  {pubKeys.map((k) => (
                    <option key={k.path} value={k.path}>
                      {k.path.replace(/^.*\/\.ssh\//, "~/.ssh/")}
                      {k.comment ? ` — ${k.comment}` : ""}
                      {k.privatePath ? "" : " (clé privée absente)"}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        ) : auth === "agent" ? (
          <p className="agent-note">
            Utilise les clés chargées dans votre agent SSH (<code>ssh-add -l</code> pour
            les voir). Aucun identifiant à saisir.
          </p>
        ) : (
          <>
            <label className="field">
              <span>Clé privée</span>
              <div className="field-row">
                <input
                  value={keyPath}
                  onChange={(e) => setKeyPath(e.target.value)}
                  placeholder="~/.ssh/id_ed25519"
                  className="mono grow"
                />
                <button type="button" className="btn" onClick={browseKey}>
                  Parcourir…
                </button>
              </div>
            </label>
            <label className="field">
              <span>Phrase de passe (si la clé en a une)</span>
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            </label>
          </>
        )}

        <label className="field">
          <span>Rebond par bastion (facultatif)</span>
          <input
            className="mono"
            value={jump}
            onChange={(e) => setJump(e.target.value)}
            placeholder="jump@bastion.exemple.fr:22"
          />
        </label>

        <div className="field-row">
          <label className="field grow">
            <span>Groupe (facultatif)</span>
            <input
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              placeholder="Prod, Clients, Perso…"
            />
          </label>
          <label className="field color-field">
            <span>Repère</span>
            <div className="color-picks">
              {["", "#e06c5a", "#d9a441", "#63b3a1", "#7099c7", "#b58ac9"].map((c) => (
                <button
                  type="button"
                  key={c || "none"}
                  className={`color-pick ${color === c ? "on" : ""}`}
                  style={c ? { background: c } : undefined}
                  title={c ? `Couleur ${c}` : "Aucune"}
                  onClick={() => setColor(c)}
                >
                  {c ? "" : "—"}
                </button>
              ))}
            </div>
          </label>
        </div>

        <label className="field">
          <span>Commandes à l'ouverture (une par ligne, facultatif)</span>
          <textarea
            className="mono profile-input"
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            placeholder={"cd /var/www\ntail -f logs/app.log"}
            rows={2}
          />
        </label>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={save}
            onChange={(e) => setSave(e.target.checked)}
          />
          <span>Garder cette connexion dans le port d'attache</span>
        </label>

        {auth === "password" && save && !copyId && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={savePassword}
              onChange={(e) => setSavePassword(e.target.checked)}
            />
            <span>
              Garder le mot de passe dans le Trousseau macOS
              <small>Stocké chiffré par le système, jamais dans l'app.</small>
            </span>
          </label>
        )}

        {error && <div className="modal-error">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Annuler
          </button>
          <button type="submit" className="btn primary" disabled={!canSubmit}>
            {busy
              ? "Connexion…"
              : mode === "edit"
                ? "Enregistrer et se connecter"
                : "Larguer les amarres"}
          </button>
        </div>
      </form>
    </div>
  );
}
