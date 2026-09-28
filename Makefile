# Gen3ia — commandes standardisées (Task 39, Rec 6.2).
# Démarrage en 5 minutes : make setup → remplir .env.local → make seed → npm run dev

.PHONY: help setup emulators seed db:reset dev lint typecheck test test:e2e test:coverage \
        build analyze check:bundle audit-secrets hooks qa

help: ## Liste les cibles disponibles
	@grep -E '^[a-zA-Z:_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS=":.*## "} {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

setup: ## Installation complète (dépendances + hooks git + .env.local)
	npm install
	-@cp -n .env.example .env.local 2>/dev/null || echo "ℹ .env.local existe déjà (ou .env.example absent)"
	@npm run setup:hooks
	@echo "✔ Setup terminé — complétez .env.local (voir README › Démarrage en 5 minutes)"

emulators: ## Démarre les émulateurs Firebase (auth 9099, firestore 8080, UI 4000)
	npx firebase-tools emulators:start --only auth,firestore

seed: ## Peuple les émulateurs (5 users, 2 équipes, 3 agents, 10 conversations)
	npm run seed

db\:reset: ## Réinitialise et re-peuple (émulateurs:exec → seed)
	npm run db:reset

dev: ## Serveur de développement Next.js
	npm run dev

lint: ## ESLint (0 warning toléré)
	npm run lint

typecheck: ## TypeScript strict (tsc --noEmit)
	npm run typecheck

test: ## Tests unitaires (vitest)
	npm run test

test\:e2e: ## Tests e2e Firebase contre ÉMULATEURS (auth+wallet, équipes/agents/facturation, règles)
	npm run test:e2e

test\:coverage: ## Tests + couverture (seuils 70/60/60/70)
	npm run test:coverage

build: ## Build production Next.js
	npm run build

analyze: ## Bundle analyzer (ANALYZE=true)
	npm run analyze

check\:bundle: ## Budget First Load JS par route (FAIL > 240 kB gzip)
	npm run check:bundle

audit-secrets: ## Scan gitleaks de tout l'historique de travail courant
	gitleaks detect --source . --config .gitleaks.toml --redact -v

hooks: ## (Ré)installe les hooks git (pre-commit anti-secrets)
	npm run setup:hooks

qa: ## QA locale complète = lint + typecheck + tests + build + budget bundle
	npm run lint
	npm run typecheck
	npm run test
	npm run build
	npm run check:bundle
	@echo "✔ QA complète verte"
