# Azure ML endpoint placeholder

Arquivos minimos para subir um Managed Online Endpoint no Azure ML e integrar o Vetorizador hoje.

## Criacao do endpoint

```powershell
az ml online-endpoint create --file azureml/online-endpoint.yml --resource-group rg-vetorizador-prod --workspace-name aml-vetorizador-prod
```

Se uma tentativa anterior falhou e o endpoint ficou inconsistente, remova e recrie:

```powershell
az ml online-endpoint delete --name vetorizador-endpoint --resource-group rg-vetorizador-prod --workspace-name aml-vetorizador-prod --yes
az ml online-endpoint create --file azureml/online-endpoint.yml --resource-group rg-vetorizador-prod --workspace-name aml-vetorizador-prod
```

## Criacao do deployment

```powershell
az ml online-deployment create --file azureml/online-deployment.yml --resource-group rg-vetorizador-prod --workspace-name aml-vetorizador-prod --all-traffic
```

## Teste do endpoint

```powershell
az ml online-endpoint invoke --name vetorizador-endpoint --deployment-name blue --request-file azureml/sample-request.json --resource-group rg-vetorizador-prod --workspace-name aml-vetorizador-prod
```

## Obter credenciais

```powershell
az ml online-endpoint get-credentials --name vetorizador-endpoint --resource-group rg-vetorizador-prod --workspace-name aml-vetorizador-prod
az ml online-endpoint show --name vetorizador-endpoint --resource-group rg-vetorizador-prod --workspace-name aml-vetorizador-prod --query scoring_uri -o tsv
```

O script atual responde com uma inferencia placeholder compativel com o fluxo de auto-inferencia do app.
O deployment atual usa uma VM menor para caber melhor em subscriptions novas com quota limitada.