# Ranking de presenteadores da live @eteguru

Ranking parcial e não oficial dos presenteadores da live. O ranking oficial do TikTok continua sendo a referência final.

## Como funciona

- `app`: conecta na live, grava os presentes, serve o site e a API (porta interna 3000).
- `db`: PostgreSQL 17, dados no volume `eteguru_pgdata`.
- A cada push na branch `main`, o GitHub Actions testa o código e publica a imagem `ghcr.io/orakysec/eteguru-ranking-app` com a tag `latest` e a tag do commit.

## Primeiro deploy no Portainer

1. **DNS**: registro tipo A `ranking` apontando para o IP da VPS.
2. **Portainer > Stacks > Add stack**. Nome: `eteguru`.
3. **Build method: Web editor**. Cole o conteúdo de `docker-compose.yml`.
4. **Environment variables**: adicione as variáveis de `.env.example` (no mínimo `SITE_DOMAIN` e `POSTGRES_PASSWORD`).
5. **Deploy the stack**.
6. Teste: `https://ranking.ykaromarques.com/healthz` deve mostrar `ok`.

## Atualizar

1. Push na `main` e espere o Actions ficar verde.
2. Portainer > Services > `eteguru_app` > **Update the service** com **Re-pull image** ligado.
   O novo container sobe antes do antigo sair, então o site não cai. Se o novo falhar no healthcheck, o Swarm volta sozinho para a versão anterior.

## Voltar uma versão

Na stack, mude `APP_IMAGE` para `ghcr.io/orakysec/eteguru-ranking-app:<hash-do-commit>` e clique em **Update the stack**.

## Desenvolvimento

```bash
npm install
npm test
npx tsx scripts/teste-coletor.ts <usuario> 3
```
