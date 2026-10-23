import os
import sys
import json
import uuid
import asyncio
import subprocess
from pathlib import Path
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
RENDER_DIR = BASE_DIR / "renders"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
RENDER_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="ClipGames API - 16:9 to 9:16 Converter", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Armazenamento simples em memória para status dos jobs de render
render_jobs: Dict[str, Dict[str, Any]] = {}

def get_video_metadata(filepath: Path) -> dict:
    """Extrai resolução, duração e fps com ffprobe."""
    cmd = [
        "ffprobe",
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate,duration,nb_frames:format=duration",
        "-of", "json",
        str(filepath)
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        data = json.loads(result.stdout)
        stream = data.get("streams", [{}])[0]
        fmt = data.get("format", {})
        
        width = int(stream.get("width", 1920))
        height = int(stream.get("height", 1080))
        
        # Duração
        duration = float(stream.get("duration") or fmt.get("duration") or 0.0)
        
        # FPS
        r_frame_rate = stream.get("r_frame_rate", "30/1")
        if "/" in r_frame_rate:
            num, den = map(float, r_frame_rate.split("/"))
            fps = round(num / den, 2) if den > 0 else 30.0
        else:
            fps = float(r_frame_rate)
            
        return {
            "width": width,
            "height": height,
            "duration": round(duration, 2),
            "fps": fps
        }
    except Exception as e:
        print(f"Erro no ffprobe: {e}")
        return {"width": 1920, "height": 1080, "duration": 0.0, "fps": 30.0}

@app.get("/api/demo")
def get_demo_video():
    demo_path = UPLOAD_DIR / "demo_lol_16x9.mp4"
    if not demo_path.exists():
        raise HTTPException(status_code=404, detail="Demo não encontrado")
    meta = get_video_metadata(demo_path)
    return {
        "videoId": "demo-lol",
        "filename": "demo_lol_16x9.mp4",
        "originalName": "Gameplay_Demo_16x9.mp4",
        "metadata": meta,
        "url": "/api/videos/demo_lol_16x9.mp4"
    }

@app.get("/api/health")
def health_check():
    return {"status": "ok", "app": "ClipGames API"}

@app.post("/api/upload")
async def upload_video(file: UploadFile = File(...)):
    """Faz upload de um clipe 16:9 e retorna metadados."""
    ext = Path(file.filename or "video.mp4").suffix
    if not ext:
        ext = ".mp4"
    video_id = str(uuid.uuid4())
    filename = f"{video_id}{ext}"
    dest_path = UPLOAD_DIR / filename
    
    with open(dest_path, "wb") as buffer:
        content = await file.read()
        buffer.write(content)
        
    meta = get_video_metadata(dest_path)
    
    return {
        "videoId": video_id,
        "filename": filename,
        "originalName": file.filename,
        "metadata": meta,
        "url": f"/api/videos/{filename}"
    }

@app.get("/api/videos/{filename}")
async def serve_video(filename: str):
    """Serve o vídeo com suporte para streaming de range."""
    path = UPLOAD_DIR / filename
    if not path.exists():
        path = RENDER_DIR / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="Vídeo não encontrado")
    return FileResponse(path, media_type="video/mp4")

class CropBox(BaseModel):
    # Coordenadas em porcentagem (0 a 100) relativas ao vídeo 16:9 original
    x: float
    y: float
    width: float
    height: float

class Keyframe(BaseModel):
    time: float
    x: float
    y: float
    width: float
    height: float

class RenderRequest(BaseModel):
    videoId: str
    filename: str
    layoutMode: str  # "split", "single_crop", "blur_fit"
    camEnabled: bool = True
    camBox: Optional[CropBox] = None
    gameBox: Optional[CropBox] = None
    gameKeyframes: Optional[List[Keyframe]] = None
    camKeyframes: Optional[List[Keyframe]] = None
    # Altura da câmera no layout split em porcentagem do frame 9:16 final (ex: 35%)
    camHeightPercent: float = 35.0
    # Estilo de fundo nos espaços (blur ou black)
    bgStyle: str = "blur"
    blurIntensity: int = 25
    showDivider: bool = True
    dividerColor: str = "white"
    # Corte de tempo (Trim)
    startTime: float = 0.0
    endTime: Optional[float] = None


def build_interpolate_expr(keyframes: Optional[List[Keyframe]], field: str, default_val: float, orig_dim: int, start_offset: float = 0.0) -> str:
    """Gera expressão de interpolação matemática temporal para crop do FFmpeg."""
    if not keyframes or len(keyframes) <= 1:
        val = getattr(keyframes[0], field) if keyframes else default_val
        pix = int((val / 100.0) * orig_dim)
        return str(max(0, pix))

    sorted_kf = sorted(keyframes, key=lambda k: k.time)
    rel_kf = []
    for k in sorted_kf:
        t_rel = max(0.0, k.time - start_offset)
        v = int((getattr(k, field) / 100.0) * orig_dim)
        rel_kf.append((t_rel, v))

    last_val = rel_kf[-1][1]
    expr = str(last_val)

    for i in range(len(rel_kf) - 2, -1, -1):
        t0, v0 = rel_kf[i]
        t1, v1 = rel_kf[i + 1]
        dt = t1 - t0
        if dt > 0.02:
            interp = f"{v0}+({v1}-{v0})*(t-{t0:.2f})/{dt:.2f}"
        else:
            interp = str(v1)
        expr = f"if(lt(t\\,{t1:.2f})\\,{interp}\\,{expr})"

    # Antes do primeiro keyframe, trava no valor v0
    first_t, first_v = rel_kf[0]
    if first_t > 0:
        expr = f"if(lt(t\\,{first_t:.2f})\\,{first_v}\\,{expr})"

    return expr


def run_ffmpeg_render(job_id: str, req: RenderRequest, input_path: Path, output_path: Path):
    meta = get_video_metadata(input_path)
    orig_w = meta["width"]
    orig_h = meta["height"]
    total_duration = meta["duration"]
    
    # Resolução padrão vertical export: 1080x1920
    OUT_W = 1080
    OUT_H = 1920
    
    filter_complex = ""
    
    if req.layoutMode == "split" and req.camEnabled and req.camBox and req.gameBox:
        # Layout Split: Cam no topo, Gameplay embaixo
        # Cam height em pixels
        h_cam_target = int(OUT_H * (req.camHeightPercent / 100.0))
        # Garantir número par
        h_cam_target = (h_cam_target // 2) * 2
        h_game_target = OUT_H - h_cam_target
        
        # Dimensões base de recorte
        cam_w = int(((req.camBox.width if req.camBox else 25.0) / 100.0) * orig_w)
        cam_h = int(((req.camBox.height if req.camBox else 30.0) / 100.0) * orig_h)
        game_w = int(((req.gameBox.width if req.gameBox else 56.0) / 100.0) * orig_w)
        game_h = int(((req.gameBox.height if req.gameBox else 80.0) / 100.0) * orig_h)

        # Interpolação dinâmica de posição para Cam e Game
        cam_x = build_interpolate_expr(req.camKeyframes, 'x', req.camBox.x if req.camBox else 4.0, orig_w, req.startTime)
        cam_y = build_interpolate_expr(req.camKeyframes, 'y', req.camBox.y if req.camBox else 5.0, orig_h, req.startTime)
        game_x = build_interpolate_expr(req.gameKeyframes, 'x', req.gameBox.x if req.gameBox else 22.0, orig_w, req.startTime)
        game_y = build_interpolate_expr(req.gameKeyframes, 'y', req.gameBox.y if req.gameBox else 10.0, orig_h, req.startTime)

        divider_line = ""
        if req.showDivider:
            divider_line = f",drawbox=y={h_cam_target - 2}:color=0x6366f1@0.8:width={OUT_W}:height=4:t=fill"

        filter_complex = (
            f"[0:v]split=2[in_cam][in_game];"
            f"[in_cam]crop={cam_w}:{cam_h}:{cam_x}:{cam_y},scale={OUT_W}:{h_cam_target}:force_original_aspect_ratio=increase,crop={OUT_W}:{h_cam_target}[cam];"
            f"[in_game]crop={game_w}:{game_h}:{game_x}:{game_y},scale={OUT_W}:{h_game_target}:force_original_aspect_ratio=increase,crop={OUT_W}:{h_game_target}[game];"
            f"[cam][game]vstack{divider_line}[vout]"
        )

    elif req.layoutMode == "blur_fit":
        # Layout Estilo YouTube Shorts (ex: Locke/Akshan): Recorte focado na ação + HUD sobreposto no Fundo Blur ou Preto
        box = req.gameBox if req.gameBox else CropBox(x=0, y=0, width=100, height=100)
        gw = int((box.width / 100.0) * orig_w)
        gh = int((box.height / 100.0) * orig_h)
        gx = build_interpolate_expr(req.gameKeyframes, 'x', box.x, orig_w, req.startTime)
        gy = build_interpolate_expr(req.gameKeyframes, 'y', box.y, orig_h, req.startTime)

        if req.bgStyle == "black":
            filter_complex = (
                f"[0:v]crop={gw}:{gh}:{gx}:{gy},scale={OUT_W}:-2[fg];"
                f"color=black:s={OUT_W}x{OUT_H}:d={total_duration}[bg];"
                f"[bg][fg]overlay=(W-w)/2:(H-h)/2[vout]"
            )
        else:
            blur_val = max(10, min(req.blurIntensity, 50))
            filter_complex = (
                f"[0:v]split=2[bg_in][fg_in];"
                f"[bg_in]scale={OUT_W}:{OUT_H}:force_original_aspect_ratio=increase,crop={OUT_W}:{OUT_H},gblur=sigma={blur_val},eq=brightness=-0.15[bg];"
                f"[fg_in]crop={gw}:{gh}:{gx}:{gy},scale={OUT_W}:-2[fg];"
                f"[bg][fg]overlay=(W-w)/2:(H-h)/2[vout]"
            )



    else:
        # Layout Single Crop (9:16 direto focado na ação/gameplay)
        box = req.gameBox if req.gameBox else CropBox(x=25, y=0, width=56.25, height=100)
        gw = int((box.width / 100.0) * orig_w)
        gh = int((box.height / 100.0) * orig_h)
        
        gx = build_interpolate_expr(req.gameKeyframes, 'x', box.x, orig_w, req.startTime)
        gy = build_interpolate_expr(req.gameKeyframes, 'y', box.y, orig_h, req.startTime)

        filter_complex = (
            f"[0:v]crop={gw}:{gh}:{gx}:{gy},scale={OUT_W}:{OUT_H}:force_original_aspect_ratio=increase,crop={OUT_W}:{OUT_H}[vout]"
        )


    input_args = []
    if req.startTime and req.startTime > 0:
        input_args.extend(["-ss", f"{req.startTime:.2f}"])
    if req.endTime and req.endTime > (req.startTime or 0):
        duration = req.endTime - (req.startTime or 0)
        input_args.extend(["-t", f"{duration:.2f}"])

    cmd = [
        "ffmpeg", "-y",
        *input_args,
        "-i", str(input_path),
        "-filter_complex", filter_complex,
        "-map", "[vout]",
        "-map", "0:a?",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        str(output_path)
    ]


    try:
        render_jobs[job_id]["status"] = "processing"
        render_jobs[job_id]["progress"] = 10
        
        # Executar comando
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace"
        )
        
        _, stderr = process.communicate()
        
        if process.returncode == 0:
            render_jobs[job_id]["status"] = "completed"
            render_jobs[job_id]["progress"] = 100
            render_jobs[job_id]["downloadUrl"] = f"/api/renders/{output_path.name}"
        else:
            render_jobs[job_id]["status"] = "failed"
            render_jobs[job_id]["error"] = stderr[-500:] if stderr else "Erro desconhecido no FFmpeg"
            print("FFmpeg error:", stderr)
    except Exception as e:
        render_jobs[job_id]["status"] = "failed"
        render_jobs[job_id]["error"] = str(e)
        print("Exception in render:", e)

@app.post("/api/render")
async def start_render(req: RenderRequest, background_tasks: BackgroundTasks):
    input_path = UPLOAD_DIR / req.filename
    if not input_path.exists():
        raise HTTPException(status_code=404, detail="Arquivo original não encontrado")
        
    job_id = str(uuid.uuid4())
    output_filename = f"clip_9x16_{job_id}.mp4"
    output_path = RENDER_DIR / output_filename
    
    render_jobs[job_id] = {
        "jobId": job_id,
        "status": "queued",
        "progress": 0,
        "outputFilename": output_filename,
        "downloadUrl": None,
        "error": None
    }
    
    background_tasks.add_task(run_ffmpeg_render, job_id, req, input_path, output_path)
    
    return {"jobId": job_id, "status": "queued"}

@app.get("/api/render/{job_id}")
async def get_render_status(job_id: str):
    if job_id not in render_jobs:
        raise HTTPException(status_code=404, detail="Job não encontrado")
    return render_jobs[job_id]

@app.get("/api/renders/{filename}")
async def download_render(filename: str):
    path = RENDER_DIR / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="Render não encontrado")
    return FileResponse(
        path,
        media_type="application/octet-stream",
        filename=filename,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Access-Control-Expose-Headers": "Content-Disposition"
        }
    )

class OpenFolderRequest(BaseModel):
    filename: Optional[str] = None

@app.post("/api/open-folder")
async def open_renders_folder(req: Optional[OpenFolderRequest] = None):
    resolved_dir = RENDER_DIR.resolve()
    target_file = None
    
    if req and req.filename:
        check_path = resolved_dir / req.filename
        if check_path.exists():
            target_file = check_path
            
    if not target_file:
        mp4_files = sorted(resolved_dir.glob("*.mp4"), key=lambda p: p.stat().st_mtime, reverse=True)
        if mp4_files:
            target_file = mp4_files[0]
            
    try:
        if os.name == 'nt':
            if target_file and target_file.exists():
                ps_cmd = f'Start-Process explorer.exe -ArgumentList "/select,`"{str(target_file)}`""'
            else:
                ps_cmd = f'Start-Process explorer.exe -ArgumentList "`"{str(resolved_dir)}`""'
            
            try:
                subprocess.Popen(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_cmd])
            except Exception:
                pass
            os.system(f'start "" "{str(resolved_dir)}"')
        else:
            subprocess.Popen(["xdg-open", str(resolved_dir)])
        return {"success": True, "path": str(resolved_dir), "file": str(target_file) if target_file else None}
    except Exception as e:
        return {"success": False, "error": str(e), "path": str(resolved_dir)}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
