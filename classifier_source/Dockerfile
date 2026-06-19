FROM python:3.10-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOST=0.0.0.0 \
    PORT=8000

# working directory inside the container
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Copy the requirements file first to utilize Docker build cache
COPY requirements.txt .

# Build-time argument to select execution mode: "cpu" or "gpu"
ARG INSTALL_TYPE=cpu

# Install python packages
RUN pip install --no-cache-dir --upgrade pip && \
    if [ "$INSTALL_TYPE" = "cpu" ]; then \
        echo "Installing CPU-optimized PyTorch..." && \
        pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu && \
        pip install --no-cache-dir -r requirements.txt; \
    else \
        echo "Installing standard GPU-enabled PyTorch..." && \
        pip install --no-cache-dir -r requirements.txt; \
    fi

# Copy the rest of the application files (model weights, configs, code)
COPY . .

EXPOSE 8000

# Health check to ensure the service is running and ready to handle requests
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/docs')" || exit 1

# Start the classifier FastAPI application
CMD ["python", "app.py"]
