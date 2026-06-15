import os
import torch
import torch.nn.functional as F
from fastapi import FastAPI, HTTPException, Header, Depends
from pydantic import BaseModel
from transformers import AutoConfig, AutoTokenizer, AutoModelForSequenceClassification, BitsAndBytesConfig

app = FastAPI(
    title="Quạt Mo Classifier API",
    description="Production-grade prompt classification API with PyTorch optimizations and security controls.",
    version="1.0.0"
)

MODEL_PATH = os.path.dirname(os.path.abspath(__file__))

# Manually load local .env file if it exists to avoid extra library dependencies (python-dotenv)
env_path = os.path.join(MODEL_PATH, ".env")
if os.path.exists(env_path):
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, val = line.split("=", 1)
                os.environ[key.strip()] = val.strip()

CLASSIFIER_API_KEY = os.environ.get("CLASSIFIER_API_KEY", "").strip()

# Global variables for model, tokenizer, and device
model = None
tokenizer = None
device = "cpu"

def verify_api_key(
    authorization: str | None = Header(None),
    x_api_key: str | None = Header(None)
):
    """
    Enforces API key authentication if CLASSIFIER_API_KEY is configured in the environment.
    Supports standard Bearer token in 'Authorization' header or 'X-API-Key' header.
    """
    if not CLASSIFIER_API_KEY:
        return
        
    token = ""
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    elif x_api_key:
        token = x_api_key.strip()
        
    if token != CLASSIFIER_API_KEY:
        raise HTTPException(
            status_code=401,
            detail="Unauthorized: Invalid or missing API key."
        )

@app.on_event("startup")
def load_model_and_warmup():
    global model, tokenizer, device
    print(f"[Classifier] Loading model from path: {MODEL_PATH}...")
    
    # 1. Load tokenizer
    tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH)
    
    # 2. Determine device and apply PyTorch hardware-level optimizations
    if torch.cuda.is_available():
        device = "cuda"
        print("[Classifier] CUDA GPU detected. Enabling hardware-level matmul & cudnn TF32 optimizations...")
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        
        # Try loading in 4-bit quantization to optimize VRAM usage (bitsandbytes dependency)
        try:
            print("[Classifier] Attempting to load with 4-bit quantization...")
            bnb_config = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_compute_dtype=torch.float16,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_use_double_quant=True
            )
            model = AutoModelForSequenceClassification.from_pretrained(
                MODEL_PATH,
                quantization_config=bnb_config,
                device_map="auto"
            )
            print("[Classifier] Model loaded successfully in 4-bit on GPU.")
        except Exception as e:
            print(f"[Classifier] Failed to load in 4-bit ({e}). Falling back to FP16 on GPU...")
            
            # Programmatically remove quantization config to prevent bitsandbytes import errors
            config = AutoConfig.from_pretrained(MODEL_PATH)
            if hasattr(config, "quantization_config"):
                delattr(config, "quantization_config")
                
            model = AutoModelForSequenceClassification.from_pretrained(
                MODEL_PATH,
                config=config,
                torch_dtype=torch.float16,
                device_map="auto"
            )
            print("[Classifier] Model loaded successfully in FP16 on GPU.")
    else:
        device = "cpu"
        print("[Classifier] CUDA NOT detected. Falling back to CPU...")
        
        # Load the model directly letting bitsandbytes handle the 4-bit quantized layout
        model = AutoModelForSequenceClassification.from_pretrained(
            MODEL_PATH,
            low_cpu_mem_usage=True,
            torch_dtype=torch.float32
        ).to(device)
        print("[Classifier] Model loaded successfully on CPU (float32).")

    model.eval()

    # 3. Model Warmup to prevent cold-start latency on first user requests
    try:
        print("[Classifier] Warming up model with dummy input...")
        dummy_messages = [{"role": "user", "content": "warmup"}]
        dummy_text = tokenizer.apply_chat_template(dummy_messages, tokenize=False)
        dummy_inputs = tokenizer(dummy_text, return_tensors="pt").to(device)
        with torch.inference_mode():
            model(**dummy_inputs)
        print("[Classifier] Warmup complete. API is fully optimized and ready.")
    except Exception as e:
        print(f"[Classifier] Warmup failed: {e}")

class ClassificationRequest(BaseModel):
    prompt: str

class ClassificationResponse(BaseModel):
    label: str
    confidence: float

@app.post("/classify", response_model=ClassificationResponse)
def classify(request: ClassificationRequest, _ = Depends(verify_api_key)):
    """
    Classify the incoming prompt.
    NOTE: Defined as a synchronous 'def' rather than 'async def'. This offloads the
    heavy CPU/GPU ML inference calculation to FastAPI's background thread pool,
    preventing the single-threaded event loop from blocking and allowing concurrent requests.
    """
    global model, tokenizer, device
    if model is None or tokenizer is None:
        raise HTTPException(status_code=503, detail="Model is currently initializing or unavailable.")
    
    try:
        # Apply Qwen2 Chat template to format the prompt correctly
        messages = [{"role": "user", "content": request.prompt}]
        templated_text = tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=False
        )
        
        # Tokenize inputs
        inputs = tokenizer(templated_text, return_tensors="pt").to(device)
        
        # Run inference using inference_mode (faster and lower memory overhead than no_grad)
        with torch.inference_mode():
            outputs = model(**inputs)
            logits = outputs.logits
            
            # Apply softmax to extract confidence score
            probs = F.softmax(logits, dim=-1)
            
            # Extract predicted label index and probability
            conf, predicted_idx_tensor = torch.max(probs, dim=-1)
            predicted_idx = int(predicted_idx_tensor.item())
            confidence = float(conf.item())
            
            # Map index back to class label (L0 - L6)
            label = model.config.id2label.get(str(predicted_idx), f"L{predicted_idx}")
            
        return ClassificationResponse(label=label, confidence=confidence)
        
    except Exception as e:
        print(f"[Classifier API] Inference error: {e}")
        raise HTTPException(status_code=500, detail=f"Inference error: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    # Default host is localhost (127.0.0.1) for secure local routing.
    # Can be overridden via HOST environment variable (e.g. '0.0.0.0' for Docker containers).
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host=host, port=port)
