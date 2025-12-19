import requests
import base64
import sys

# Recebe imagem base64 via argumento
if len(sys.argv) < 2:
    print("Uso: python segment_anything.py <base64_image>")
    sys.exit(1)

base64_image = sys.argv[1]

# Decodifica imagem base64 para bytes
image_bytes = base64.b64decode(base64_image)

# Hugging Face API endpoint para Segment Anything
API_URL = "https://api-inference.huggingface.co/models/facebook/sam-vit-huge"
headers = {"Authorization": "Bearer hf_xxx"}  # Substitua por seu token gratuito Hugging Face

response = requests.post(API_URL, headers=headers, files={"image": image_bytes})

if response.status_code == 200:
    result = response.json()
    # O resultado contém máscaras segmentadas. Você pode processar para SVG conforme necessário.
    print(result)
else:
    print(f"Erro: {response.status_code}")
    print(response.text)
