# Cabestan

Client SFTP et terminal SSH pour macOS — un FileZilla et un terminal dans la
même fenêtre, en encre marine et laiton. Tauri (Rust) + React/TypeScript.

## Installer une version publiée

Chaque tag `v*` produit une release GitHub avec l'app en zip. L'app est signée
en ad hoc, pas notariée : macOS la met en quarantaine au téléchargement.
Après avoir glissé `Cabestan.app` dans `/Applications`, soit clic droit →
Ouvrir à la première ouverture, soit :

```bash
xattr -dr com.apple.quarantine /Applications/Cabestan.app
```

## Lancer

```bash
npm install
npm run tauri dev     # développement
npm run deploy        # construit et installe dans /Applications
```

`npm run deploy` est l'étape qui manque à `tauri build` : ce dernier écrit dans
`src-tauri/target` et ne touche jamais `/Applications`, si bien que l'app lancée
depuis le Launchpad reste celle du build précédent. Le script signe le bundle
en ad hoc, remplace la version installée et retire le drapeau de quarantaine.
`npm run deploy:rapide` réinstalle le dernier build sans reconstruire.

La version installée est affichée sous le nom de l'app, dans la barre latérale.

Le bundler DMG de Tauri échoue hors session graphique ; le cas échéant,
fabriquer l'image à la main avec `hdiutil create` à partir du `.app`.

## Tests

Trois suites, à lancer dans cet ordre.

```bash
npm test                   # 214 tests de logique et de composants (Vitest)
cd src-tauri && cargo test  # 9 tests unitaires Rust
```

Les tests d'intégration SSH parlent à un vrai serveur : ils sont marqués
`#[ignore]` et demandent le conteneur de test et la clé dans l'agent.

```bash
docker run -d --name cabestan-test-ssh -p 2222:2222 \
  -e PASSWORD_ACCESS=true -e USER_NAME=marin -e USER_PASSWORD=escale \
  -e PUBLIC_KEY="$(cat ~/.ssh/cabestan_test.pub)" \
  lscr.io/linuxserver/openssh-server:latest
```

```bash
ssh-add ~/.ssh/cabestan_test
```

```bash
cd src-tauri && cargo test -- --ignored --test-threads=1
```

`--test-threads=1` est nécessaire : plusieurs de ces tests écrivent dans le même
`authorized_keys` distant et dans `~/.ssh/known_hosts`.

Deux de ces tests parlent au Docker de la machine : `execute_docker_en_local`
vérifie la découverte du binaire et l'exécution réelle, `suit_les_journaux_en_direct`
vérifie qu'un flux `docker logs --follow` arrive au fil de l'eau et s'arrête.
Ils échouent, à raison, si aucun démon Docker ne tourne.

## Organisation

- `src-tauri/src/ssh.rs` — connexions, SFTP, tunnels, commandes distantes
- `src-tauri/src/local.rs` — terminaux locaux (PTY)
- `src-tauri/src/docker.rs` — client Docker, local et distant
- `src-tauri/src/lib.rs` — menus, raccourcis, enregistrement des commandes
- `src/App.tsx` — onglets, panneaux, arbitrage des zones, modales
- `src/components/` — explorateur, terminal, éditeur, vues et modales
- `src-tauri/src/git.rs` — client Git, local et distant
- Modules de logique pure, tous testés : `panes`, `shortcuts`, `api`, `config`,
  `queue`, `virtual`, `tabulate`, `logview`, `tree`, `guards`, `themes`,
  `settings`, `snippets`, `workspaces`, `fileactions`, `diff`, `docker`, `git`
