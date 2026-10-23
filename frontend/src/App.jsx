import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  Upload, Film, Smartphone, Sliders, Scissors, Play, Pause, 
  ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Download, CheckCircle, 
  AlertCircle, RefreshCw, Layers, Eye, Sparkles, Video,
  Plus, Trash2, Crosshair, Compass, CircleDot, FolderOpen, Cpu
} from 'lucide-react';
import { extractVideoMetadata, renderVideoClientSide } from './services/videoRenderer';


export default function App() {
  const [videoFile, setVideoFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState(null);
  const [uploadedData, setUploadedData] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);

  // Modos de layout: "split" (Cam + Gameplay), "single_crop" (Só Gameplay 9:16), "blur_fit" (Fit centralizado com Blur)
  const [layoutMode, setLayoutMode] = useState('split');
  const [camEnabled, setCamEnabled] = useState(true);

  // Caixa de recorte da Câmera (porcentagens 0..100)
  const [camBox, setCamBox] = useState({
    x: 4,
    y: 5,
    width: 25,
    height: 30
  });

  // Caixa de recorte da Gameplay (porcentagens 0..100)
  const [gameBox, setGameBox] = useState({
    x: 22,
    y: 10,
    width: 56,
    height: 80
  });

  // Keyframes de movimento dinâmico da câmera (Pan & Scan)
  const [gameKeyframes, setGameKeyframes] = useState([]);

  // Qual caixa está selecionada para edição com as setinhas: 'cam' ou 'game'
  const [activeBoxTarget, setActiveBoxTarget] = useState('game');

  // Altura da seção da Câmera no celular (em % da altura total 9:16)
  const [camHeightPercent, setCamHeightPercent] = useState(35);
  const [blurIntensity, setBlurIntensity] = useState(25);
  const [showDivider, setShowDivider] = useState(true);
  const [bgStyle, setBgStyle] = useState('blur'); // 'blur' (ofuscado estilo Shorts) ou 'black' (preto sólido)

  // Estado de renderização
  const [renderJobId, setRenderJobId] = useState(null);
  const [renderStatus, setRenderStatus] = useState(null); // 'queued', 'processing', 'completed', 'failed'
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderLog, setRenderLog] = useState('');
  const [downloadUrl, setDownloadUrl] = useState(null);
  const [renderError, setRenderError] = useState(null);
  const [folderNotice, setFolderNotice] = useState(null);


  // Tamanho do Preview do Celular: 'sm' (270px), 'md' (340px), 'lg' (410px)
  const [phoneSize, setPhoneSize] = useState('md');

  // Corte de Duração do Vídeo (Trim)
  const [videoDuration, setVideoDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);

  // Canvas e referências
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  const isDraggingRef = useRef(null); // 'cam' ou 'game'
  const dragStartRef = useRef({ x: 0, y: 0, boxX: 0, boxY: 0 });


  // Formatar segundos em 00:00.0
  const formatTime = (secs) => {
    if (isNaN(secs) || secs < 0) return '00:00.0';
    const m = Math.floor(secs / 60);
    const s = (secs % 60).toFixed(1);
    const sStr = Number(s) < 10 ? `0${s}` : s;
    return `${m < 10 ? '0' : ''}${m}:${sStr}`;
  };

  // Controlar play/pause sincronizado
  const togglePlay = () => {

    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play();
      setIsPlaying(true);
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
    }
  };

  // Interpolação matemática entre pontos de câmera (Keyframes)

  const getInterpolatedBox = useCallback((kfs, defaultBox, time) => {
    if (!kfs || kfs.length === 0) return defaultBox;
    if (kfs.length === 1) return { ...defaultBox, x: kfs[0].x, y: kfs[0].y };

    const sorted = [...kfs].sort((a, b) => a.time - b.time);
    if (time <= sorted[0].time) return { ...defaultBox, x: sorted[0].x, y: sorted[0].y };
    if (time >= sorted[sorted.length - 1].time) {
      const last = sorted[sorted.length - 1];
      return { ...defaultBox, x: last.x, y: last.y };
    }

    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (time >= a.time && time <= b.time) {
        const p = (time - a.time) / (b.time - a.time);
        const x = a.x + (b.x - a.x) * p;
        const y = a.y + (b.y - a.y) * p;
        return { ...defaultBox, x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) };
      }
    }
    return defaultBox;
  }, []);

  // Adicionar ou atualizar keyframe no segundo atual
  const handleAddKeyframe = () => {
    const curTime = Number(currentTime.toFixed(2));
    setGameKeyframes(prev => {
      const filtered = prev.filter(k => Math.abs(k.time - curTime) > 0.25);
      const updated = [...filtered, {
        time: curTime,
        x: gameBox.x,
        y: gameBox.y,
        width: gameBox.width,
        height: gameBox.height
      }].sort((a, b) => a.time - b.time);
      return updated;
    });
  };

  const handleRemoveCurrentKeyframe = () => {
    setGameKeyframes(prev => prev.filter(k => Math.abs(k.time - currentTime) > 0.35));
  };

  const handleClearAllKeyframes = () => {
    setGameKeyframes([]);
  };

  const hasKeyframeAtCurrent = gameKeyframes.some(k => Math.abs(k.time - currentTime) <= 0.35);

  // Loop do Canvas: Renderiza O MESMO VÍDEO ao vivo a 60fps sem dessincronização
  useEffect(() => {
    let animId;
    const renderCanvas = () => {
      const canvas = canvasRef.current;
      const video = videoRef.current;

      if (canvas && video && video.readyState >= 2) {
        const ctx = canvas.getContext('2d');
        const cw = canvas.width;
        const ch = canvas.height;
        const vw = video.videoWidth || 1920;
        const vh = video.videoHeight || 1080;

        // 1. Camada de Fundo (Blur estilo Shorts ou Preto)
        if (bgStyle === 'blur') {
          ctx.filter = 'blur(22px) brightness(0.65)';
          ctx.drawImage(video, 0, 0, cw, ch);
          ctx.filter = 'none';
        } else {
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, cw, ch);
        }

        const curGame = isDraggingRef.current === 'game' 
          ? gameBox 
          : getInterpolatedBox(gameKeyframes, gameBox, video.currentTime);

        // Função que desenha recorte preservando 100% a proporção dos pixels (nunca estica)
        const drawPreserveAspect = (bX, bY, bW, bH, dx, dy, dw, dh) => {
          const sx = (bX / 100) * vw;
          const sy = (bY / 100) * vh;
          const sw = Math.max(2, (bW / 100) * vw);
          const sh = Math.max(2, (bH / 100) * vh);

          const srcAspect = sw / sh;
          const destAspect = dw / dh;

          let finalSx = sx;
          let finalSy = sy;
          let finalSw = sw;
          let finalSh = sh;

          if (srcAspect > destAspect) {
            const adjustedSw = sh * destAspect;
            finalSx = sx + (sw - adjustedSw) / 2;
            finalSw = adjustedSw;
          } else {
            const adjustedSh = sw / destAspect;
            finalSy = sy + (sh - adjustedSh) / 2;
            finalSh = adjustedSh;
          }

          finalSx = Math.max(0, Math.min(vw - finalSw, finalSx));
          finalSy = Math.max(0, Math.min(vh - finalSh, finalSy));

          ctx.drawImage(video, finalSx, finalSy, finalSw, finalSh, dx, dy, dw, dh);
        };

        if (layoutMode === 'split' && camEnabled) {
          const camH = ch * (camHeightPercent / 100);
          const gameH = ch - camH;

          // Desenhar Facecam no topo sem esticar
          drawPreserveAspect(camBox.x, camBox.y, camBox.width, camBox.height, 0, 0, cw, camH);

          // Linha divisória neon
          if (showDivider) {
            ctx.fillStyle = '#6366f1';
            ctx.fillRect(0, camH - 2, cw, 4);
          }

          // Desenhar Gameplay na base sem esticar
          drawPreserveAspect(curGame.x, curGame.y, curGame.width, curGame.height, 0, camH, cw, gameH);

        } else if (layoutMode === 'blur_fit') {
          // Layout LoL Shorts (Locke): Gameplay recortada e centralizada proporcionalmente com fundo blur/preto
          const gsx = (curGame.x / 100) * vw;
          const gsy = (curGame.y / 100) * vh;
          const gsw = Math.max(2, (curGame.width / 100) * vw);
          const gsh = Math.max(2, (curGame.height / 100) * vh);

          // Escala para ocupar a largura do canvas mantendo proporção 1:1 dos pixels
          const fgW = cw;
          const fgH = cw * (gsh / gsw);
          const fgY = (ch - fgH) / 2;

          ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
          ctx.shadowBlur = 18;
          ctx.drawImage(video, gsx, gsy, gsw, gsh, 0, fgY, fgW, fgH);
          ctx.shadowColor = 'transparent';
          ctx.shadowBlur = 0;

        } else {

          // Single Crop (9:16 direto na Gameplay sem esticar)
          drawPreserveAspect(curGame.x, curGame.y, curGame.width, curGame.height, 0, 0, cw, ch);
        }
      }
      animId = requestAnimationFrame(renderCanvas);
    };


    animId = requestAnimationFrame(renderCanvas);
    return () => cancelAnimationFrame(animId);
  }, [layoutMode, camEnabled, camBox, gameBox, gameKeyframes, camHeightPercent, showDivider, isPlaying, bgStyle, getInterpolatedBox]);



  // Upload do arquivo (100% Client-Side)
  const handleFileUpload = async (file) => {
    if (!file) return;
    setIsUploading(true);
    try {
      const localBlob = URL.createObjectURL(file);
      setVideoUrl(localBlob);
      setVideoFile(file);

      // Extrai metadados instantaneamente via HTML5 Video element
      const meta = await extractVideoMetadata(file);
      setUploadedData({
        videoId: 'local-' + Date.now(),
        filename: file.name,
        originalName: file.name,
        metadata: meta,
        url: localBlob,
        fileObj: file
      });

      if (meta.duration) {
        setVideoDuration(meta.duration);
        setTrimStart(0);
        setTrimEnd(meta.duration);
      }
    } catch (err) {
      console.error('Erro ao ler vídeo:', err);
      alert('Não foi possível ler os metadados do vídeo selecionado.');
    } finally {
      setIsUploading(false);
    }
  };

  // Carregar vídeo demo de teste (100% Client-Side da pasta public)
  const handleLoadDemo = async () => {
    setIsUploading(true);
    try {
      const demoUrl = '/demo_lol_16x9.mp4';
      const meta = await extractVideoMetadata(demoUrl);
      setUploadedData({
        videoId: 'demo-lol',
        filename: 'demo_lol_16x9.mp4',
        originalName: 'Gameplay_Demo_16x9.mp4',
        metadata: meta,
        url: demoUrl
      });
      setVideoUrl(demoUrl);
      setVideoFile(null);
      if (meta.duration) {
        setVideoDuration(meta.duration);
        setTrimStart(0);
        setTrimEnd(meta.duration);
      }
    } catch (err) {
      console.error('Erro ao carregar demo:', err);
      alert('Vídeo demo não encontrado na pasta pública.');
    } finally {
      setIsUploading(false);
    }
  };

  // Movimentação com as setinhas (D-Pad ou Teclado)
  const moveBox = (dx, dy) => {
    const isCam = activeBoxTarget === 'cam';
    const target = isCam ? camBox : gameBox;
    const setTarget = isCam ? setCamBox : setGameBox;

    const newX = Math.max(0, Math.min(100 - target.width, target.x + dx));
    const newY = Math.max(0, Math.min(100 - target.height, target.y + dy));

    setTarget(prev => ({
      ...prev,
      x: Number(newX.toFixed(1)),
      y: Number(newY.toFixed(1))
    }));
  };

  // Ajuste de tamanho (Zoom/Escala)
  const resizeBox = (dw, dh) => {
    const isCam = activeBoxTarget === 'cam';
    const target = isCam ? camBox : gameBox;
    const setTarget = isCam ? setCamBox : setGameBox;

    const newW = Math.max(10, Math.min(100 - target.x, target.width + dw));
    const newH = Math.max(10, Math.min(100 - target.y, target.height + dh));

    setTarget(prev => ({
      ...prev,
      width: Number(newW.toFixed(1)),
      height: Number(newH.toFixed(1))
    }));
  };

  // Iniciar renderização FFmpeg 100% Client-Side (WebAssembly)
  const handleStartRender = async () => {
    if (!uploadedData && !videoFile) {
      alert('Por favor, envie um clipe primeiro.');
      return;
    }

    setRenderStatus('processing');
    setRenderProgress(5);
    setRenderLog('Carregando motor FFmpeg WebAssembly...');
    setRenderError(null);
    setDownloadUrl(null);

    try {
      const videoSource = videoFile || uploadedData?.fileObj || uploadedData?.url || '/demo_lol_16x9.mp4';
      const options = {
        layoutMode,
        camEnabled: layoutMode === 'split' ? camEnabled : false,
        camBox,
        gameBox,
        camHeightPercent,
        blurIntensity,
        bgStyle,
        gameKeyframes: gameKeyframes.length > 0 ? gameKeyframes : undefined,
        startTime: trimStart,
        endTime: trimEnd > trimStart ? trimEnd : (videoDuration || undefined)
      };

      const result = await renderVideoClientSide({
        videoSource,
        options,
        metadata: uploadedData?.metadata,
        onProgress: (pct) => {
          setRenderProgress(pct);
          setRenderLog(`Renderizando clipe no navegador... ${pct}%`);
        },
        onLog: (msg) => {
          if (msg && typeof msg === 'string' && msg.includes('frame=')) {
            const framePart = msg.split('fps=')[0].trim();
            setRenderLog(`FFmpeg: ${framePart}`);
          }
        }
      });

      setDownloadUrl(result.downloadUrl);
      setRenderStatus('completed');
      setRenderProgress(100);
      setRenderLog('Concluído!');
    } catch (err) {
      console.error('Erro na renderização Client-Side:', err);
      setRenderStatus('failed');
      setRenderError(err.message || 'Erro durante a renderização no navegador.');
    }
  };

  // Função de download direto e imediato
  const handleDownloadVideo = (url) => {
    const targetUrl = url || downloadUrl;
    if (!targetUrl) return;

    const cleanName = uploadedData?.originalName ? uploadedData.originalName.replace(/\.[^/.]+$/, "") : "clip";
    const filename = `${cleanName}_9x16.mp4`;

    const a = document.createElement('a');
    a.href = targetUrl;
    a.setAttribute('download', filename);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // Preset Padrão LoL Shorts (45% largura, 100% altura, centralizado + blur)
  const applyDefaultLolShorts = () => {
    setLayoutMode('blur_fit');
    setBgStyle('blur');
    setGameBox({
      x: 27.5, // Centralizado: (100 - 45) / 2 = 27.5
      y: 0,
      width: 45,
      height: 100
    });
    setActiveBoxTarget('game');
  };

  // Abrir / Notificar pasta de downloads
  const handleOpenFolder = () => {
    setFolderNotice("O vídeo é gerado diretamente na memória do seu navegador e salvo na sua pasta 'Downloads' ao clicar em Baixar MP4.");
    setTimeout(() => setFolderNotice(null), 6000);
  };


  // Suporte a setas do teclado físico
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ignorar se estiver digitando em um input
      if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
      
      if (e.key === 'ArrowUp') { e.preventDefault(); moveBox(0, -2); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); moveBox(0, 2); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); moveBox(-2, 0); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); moveBox(2, 0); }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeBoxTarget, camBox, gameBox]);

  // Arraste do mouse na caixa de recorte
  const handleMouseDown = (e, boxType) => {
    e.stopPropagation();
    setActiveBoxTarget(boxType);
    isDraggingRef.current = boxType;
    const box = boxType === 'cam' ? camBox : gameBox;
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      boxX: box.x,
      boxY: box.y
    };
  };

  const handleMouseMove = (e) => {
    if (!isDraggingRef.current || !stageRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    const dx = ((e.clientX - dragStartRef.current.x) / rect.width) * 100;
    const dy = ((e.clientY - dragStartRef.current.y) / rect.height) * 100;

    const isCam = isDraggingRef.current === 'cam';
    const box = isCam ? camBox : gameBox;
    const setBox = isCam ? setCamBox : setGameBox;

    const newX = Math.max(0, Math.min(100 - box.width, dragStartRef.current.boxX + dx));
    const newY = Math.max(0, Math.min(100 - box.height, dragStartRef.current.boxY + dy));

    setBox(prev => ({
      ...prev,
      x: Number(newX.toFixed(1)),
      y: Number(newY.toFixed(1))
    }));
  };

  const handleMouseUp = () => {
    isDraggingRef.current = null;
  };

  return (
    <div onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <header className="app-header">
        <div className="logo-container">
          <div className="logo-badge">
            <Video size={20} color="#fff" />
          </div>
          <span className="logo-title">ClipGames <span style={{ color: '#6366f1' }}>9:16</span></span>
          <span className="logo-sub">LoL & Gameplay Formatter</span>
          <span style={{ 
            background: 'rgba(99, 102, 241, 0.12)', 
            border: '1px solid rgba(99, 102, 241, 0.3)', 
            color: '#a5b4fc', 
            fontSize: '0.72rem', 
            fontWeight: '600', 
            padding: '3px 10px', 
            borderRadius: '999px', 
            display: 'inline-flex', 
            alignItems: 'center', 
            gap: '5px',
            marginLeft: '8px'
          }}>
            <Cpu size={12} color="#818cf8" /> WebAssembly Wasm
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          {uploadedData && (
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: '#10b981' }}></span>
              {uploadedData.originalName} ({uploadedData.metadata?.width}x{uploadedData.metadata?.height} - {uploadedData.metadata?.duration}s)
            </div>
          )}
        </div>
      </header>


      {/* Main Content */}
      <main className="main-layout" style={{ flex: 1 }}>
        {!videoUrl ? (
          /* Tela Inicial de Upload */
          <div style={{ maxWidth: '780px', margin: '40px auto 0 auto' }}>
            <div 
              className="upload-card"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (e.dataTransfer.files?.[0]) handleFileUpload(e.dataTransfer.files[0]);
              }}
              onClick={() => document.getElementById('video-input').click()}
            >
              <input 
                id="video-input" 
                type="file" 
                accept="video/*" 
                style={{ display: 'none' }} 
                onChange={(e) => {
                  if (e.target.files?.[0]) handleFileUpload(e.target.files[0]);
                }} 
              />
              <div className="upload-icon-wrapper">
                <Upload size={36} />
              </div>
              <h2 style={{ fontSize: '1.4rem', fontWeight: '800', marginBottom: '8px' }}>
                Arraste seu clipe de LoL ou Gameplay (16:9)
              </h2>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.95rem', maxWidth: '480px', margin: '0 auto 20px auto' }}>
                Formatamos e enquadramos sua play automaticamente para TikTok, Reels e Shorts (9:16) com alta fidelidade e sem perda de qualidade.
              </p>
              <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
                <button className="btn-primary" style={{ display: 'inline-flex', width: 'auto', padding: '12px 28px' }}>
                  <Film size={18} />
                  Selecionar Vídeo do Computador
                </button>
                <button 
                  type="button"
                  className="button-tab" 
                  style={{ padding: '12px 20px', background: 'rgba(255, 255, 255, 0.08)' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleLoadDemo();
                  }}
                >
                  <Sparkles size={16} color="var(--accent-cyan)" />
                  Testar com Clipe Exemplo
                </button>
              </div>
            </div>

            <div style={{ marginTop: '28px', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', textAlign: 'center' }}>
              <div className="panel" style={{ padding: '16px' }}>
                <Layers size={22} color="var(--primary)" style={{ margin: '0 auto 8px auto' }} />
                <h4 style={{ fontSize: '0.9rem', marginBottom: '4px' }}>Split com Facecam</h4>
                <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Câmera no topo e a ação do jogo no centro</p>
              </div>
              <div className="panel" style={{ padding: '16px' }}>
                <Scissors size={22} color="var(--accent-cyan)" style={{ margin: '0 auto 8px auto' }} />
                <h4 style={{ fontSize: '0.9rem', marginBottom: '4px' }}>Só Gameplay (Full)</h4>
                <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Recorte 9:16 direto quando o clipe não tem câmera</p>
              </div>
              <div className="panel" style={{ padding: '16px' }}>
                <Sparkles size={22} color="var(--accent-emerald)" style={{ margin: '0 auto 8px auto' }} />
                <h4 style={{ fontSize: '0.9rem', marginBottom: '4px' }}>Fundo Desfocado</h4>
                <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Vídeo 16:9 completo com blur elegante atrás</p>
              </div>
            </div>
          </div>
        ) : (
          /* Workspace do Editor */
          <div className="editor-workspace">
            {/* Lado Esquerdo: Vídeo Original + Caixas de Ajuste Interativas */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div className="panel">
                <div className="panel-header">
                  <div className="panel-title">
                    <Film size={18} color="var(--primary)" />
                    <span>Vídeo Original (16:9) - Ajuste as Áreas de Enquadramento</span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button 
                      onClick={() => {
                        setVideoUrl(null);
                        setUploadedData(null);
                      }} 
                      style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                    >
                      <RefreshCw size={14} /> Trocar Vídeo
                    </button>
                  </div>
                </div>

                {/* Palco do Vídeo com Caixas Sobrepostas */}
                <div className="video-stage-container" ref={stageRef}>
                  <video 
                    ref={videoRef}
                    src={videoUrl} 
                    playsInline 
                    loop 
                    muted 
                    onClick={togglePlay}
                    onTimeUpdate={(e) => setCurrentTime(e.target.currentTime)}
                    onLoadedMetadata={(e) => {
                      if (e.target.duration) {
                        setVideoDuration(e.target.duration);
                        if (!trimEnd || trimEnd === 0) setTrimEnd(e.target.duration);
                      }
                    }}
                  />

                  {/* Camada das Caixas de Recorte */}
                  <div className="crop-overlay-layer">
                    {/* Caixa 1: Câmera (só se modo split e camEnabled) */}
                    {layoutMode === 'split' && camEnabled && (
                      <div 
                        className={`crop-box box-cam ${activeBoxTarget === 'cam' ? 'selected' : ''}`}
                        style={{
                          left: `${camBox.x}%`,
                          top: `${camBox.y}%`,
                          width: `${camBox.width}%`,
                          height: `${camBox.height}%`
                        }}
                        onMouseDown={(e) => handleMouseDown(e, 'cam')}
                      >
                        <span className="crop-box-badge">📷 Facecam</span>
                      </div>
                    )}

                    {/* Caixa 2: Gameplay (Sempre ajustável e interpolada por keyframes) */}
                    {(() => {
                      const curDisplayGame = (isDraggingRef.current === 'game' || gameKeyframes.length === 0)
                        ? gameBox
                        : getInterpolatedBox(gameKeyframes, gameBox, currentTime);
                      return (
                        <div 
                          className={`crop-box box-game ${activeBoxTarget === 'game' ? 'selected' : ''}`}
                          style={{
                            left: `${curDisplayGame.x}%`,
                            top: `${curDisplayGame.y}%`,
                            width: `${curDisplayGame.width}%`,
                            height: `${curDisplayGame.height}%`
                          }}
                          onMouseDown={(e) => handleMouseDown(e, 'game')}
                        >
                          <span className="crop-box-badge">
                            🎮 Gameplay {gameKeyframes.length > 0 ? '💠 Animada' : ''}
                          </span>
                        </div>
                      );
                    })()}
                  </div>
                </div>



                {/* Barra de controle de Playback e Navegação na Timeline */}
                <div className="video-control-bar" style={{ flexWrap: 'wrap' }}>
                  <button 
                    onClick={togglePlay} 
                    style={{ background: 'var(--primary)', border: 'none', color: '#fff', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}
                  >
                    {isPlaying ? <Pause size={18} /> : <Play size={18} style={{ marginLeft: '2px' }} />}
                  </button>

                  <div style={{ flex: 1, minWidth: '180px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input 
                      type="range"
                      min="0"
                      max={videoDuration || 100}
                      step="0.05"
                      value={currentTime}
                      onChange={(e) => {
                        const t = Number(e.target.value);
                        setCurrentTime(t);
                        if (videoRef.current) videoRef.current.currentTime = t;
                      }}
                      className="slider-input"
                      style={{ accentColor: 'var(--primary)', height: '6px' }}
                    />
                  </div>

                  <span style={{ fontSize: '0.82rem', fontFamily: 'var(--font-mono)', color: 'var(--text-main)', minWidth: '110px', textAlign: 'right' }}>
                    {formatTime(currentTime)} / {formatTime(videoDuration)}
                  </span>
                </div>

                {/* Painel Dedicado de Corte do Vídeo (Trim Início e Fim) */}
                <div className="trim-card">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: '700', fontSize: '0.9rem', color: '#fff' }}>
                      <Scissors size={16} color="var(--accent-cyan)" />
                      <span>Cortar Duração do Clipe</span>
                    </div>
                    <span style={{ fontSize: '0.78rem', color: 'var(--accent-cyan)', background: 'rgba(6, 182, 212, 0.1)', padding: '2px 8px', borderRadius: '4px', border: '1px solid rgba(6, 182, 212, 0.25)' }}>
                      Duração final: {(trimEnd > trimStart ? trimEnd - trimStart : (videoDuration || 0)).toFixed(1)}s
                    </span>
                  </div>

                  {/* Barra Visual da Faixa Cortada */}
                  <div className="trim-timeline-track">
                    {videoDuration > 0 && (
                      <div 
                        className="trim-timeline-highlight"
                        style={{
                          left: `${(trimStart / videoDuration) * 100}%`,
                          width: `${Math.max(1, ((trimEnd - trimStart) / videoDuration) * 100)}%`
                        }}
                      />
                    )}
                  </div>

                  {/* Botões de marcação rápida e sliders */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    <div style={{ background: 'rgba(255, 255, 255, 0.03)', padding: '10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-card)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                        <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Ponto de Início:</span>
                        <span style={{ fontSize: '0.8rem', fontFamily: 'var(--font-mono)', fontWeight: '700', color: 'var(--primary)' }}>{formatTime(trimStart)}</span>
                      </div>
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                        <input 
                          type="range"
                          min="0"
                          max={Math.max(0, (trimEnd || videoDuration) - 0.5)}
                          step="0.1"
                          value={trimStart}
                          onChange={(e) => setTrimStart(Number(e.target.value))}
                          className="slider-input"
                        />
                        <button 
                          type="button"
                          className="trim-btn"
                          title="Definir início no tempo atual do player"
                          onClick={() => setTrimStart(currentTime)}
                        >
                          Definir
                        </button>
                      </div>
                    </div>

                    <div style={{ background: 'rgba(255, 255, 255, 0.03)', padding: '10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-card)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                        <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Ponto Final:</span>
                        <span style={{ fontSize: '0.8rem', fontFamily: 'var(--font-mono)', fontWeight: '700', color: 'var(--accent-cyan)' }}>{formatTime(trimEnd || videoDuration)}</span>
                      </div>
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                        <input 
                          type="range"
                          min={Math.min(videoDuration, trimStart + 0.5)}
                          max={videoDuration || 100}
                          step="0.1"
                          value={trimEnd || videoDuration}
                          onChange={(e) => setTrimEnd(Number(e.target.value))}
                          className="slider-input"
                        />
                        <button 
                          type="button"
                          className="trim-btn"
                          title="Definir fim no tempo atual do player"
                          onClick={() => setTrimEnd(currentTime)}
                        >
                          Definir
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>


              {/* Controles de Ajuste Fino e Setinhas */}
              <div className="panel">
                <div className="panel-header">
                  <div className="panel-title">
                    <Sliders size={18} color="var(--accent-cyan)" />
                    <span>Controles de Posição e Setinhas</span>
                  </div>
                  {/* Seletor de qual caixa está controlando */}
                  {layoutMode === 'split' && camEnabled && (
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button 
                        className={`button-tab ${activeBoxTarget === 'game' ? 'active' : ''}`}
                        onClick={() => setActiveBoxTarget('game')}
                        style={{ padding: '6px 12px', fontSize: '0.78rem' }}
                      >
                        🎮 Gameplay
                      </button>
                      <button 
                        className={`button-tab ${activeBoxTarget === 'cam' ? 'active' : ''}`}
                        onClick={() => setActiveBoxTarget('cam')}
                        style={{ padding: '6px 12px', fontSize: '0.78rem' }}
                      >
                        📷 Facecam
                      </button>
                    </div>
                  )}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 180px', gap: '20px', alignItems: 'center' }}>
                  {/* Presets Rápidos e Sliders */}
                  <div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '8px' }}>
                      Presets rápidos para <strong>{activeBoxTarget === 'cam' ? 'Câmera' : 'Gameplay'}</strong>:
                    </div>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '14px' }}>
                      {activeBoxTarget === 'cam' ? (
                        <>
                          <button className="button-tab" style={{ padding: '6px 10px', fontSize: '0.75rem' }} onClick={() => setCamBox({ x: 4, y: 5, width: 25, height: 32 })}>Canto Sup. Esquerdo</button>
                          <button className="button-tab" style={{ padding: '6px 10px', fontSize: '0.75rem' }} onClick={() => setCamBox({ x: 71, y: 5, width: 25, height: 32 })}>Canto Sup. Direito</button>
                          <button className="button-tab" style={{ padding: '6px 10px', fontSize: '0.75rem' }} onClick={() => setCamBox({ x: 71, y: 62, width: 25, height: 32 })}>Canto Inf. Direito</button>
                        </>
                      ) : (
                        <>
                          <button 
                            type="button"
                            className="button-tab" 
                            style={{ 
                              padding: '6px 12px', 
                              fontSize: '0.78rem', 
                              background: 'rgba(99, 102, 241, 0.2)', 
                              borderColor: 'var(--primary)', 
                              color: '#fff',
                              fontWeight: '700',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '5px'
                            }} 
                            onClick={applyDefaultLolShorts}
                            title="Aplica 45% largura, 100% altura, centralizado e modelo LoL Shorts com Blur"
                          >
                            <Sparkles size={14} color="#818cf8" /> ⭐ Padrão LoL Shorts (45% x 100% + Blur)
                          </button>
                          <button className="button-tab" style={{ padding: '6px 10px', fontSize: '0.75rem', borderColor: 'var(--accent-cyan)', color: 'var(--accent-cyan)' }} onClick={() => setGameBox({ x: 14, y: 12, width: 72, height: 86 })}>🔥 Estilo Locke (Ação + Skills)</button>
                          <button className="button-tab" style={{ padding: '6px 10px', fontSize: '0.75rem' }} onClick={() => setGameBox({ x: 22, y: 10, width: 56, height: 80 })}>Centro Padrão</button>
                          <button className="button-tab" style={{ padding: '6px 10px', fontSize: '0.75rem' }} onClick={() => setGameBox({ x: 0, y: 0, width: 100, height: 100 })}>16:9 Completo</button>
                        </>
                      )}
                    </div>


                    {/* Sliders de Zoom/Tamanho da Caixa */}
                    <div className="slider-group">
                      <div className="slider-label">
                        <span>Largura da Área ({activeBoxTarget === 'cam' ? camBox.width : gameBox.width}%)</span>
                      </div>
                      <input 
                        type="range" 
                        min="15" 
                        max="100" 
                        value={activeBoxTarget === 'cam' ? camBox.width : gameBox.width}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          if (activeBoxTarget === 'cam') setCamBox(p => ({ ...p, width: val }));
                          else setGameBox(p => ({ ...p, width: val }));
                        }}
                        className="slider-input" 
                      />
                    </div>

                    <div className="slider-group">
                      <div className="slider-label">
                        <span>Altura da Área ({activeBoxTarget === 'cam' ? camBox.height : gameBox.height}%)</span>
                      </div>
                      <input 
                        type="range" 
                        min="15" 
                        max="100" 
                        value={activeBoxTarget === 'cam' ? camBox.height : gameBox.height}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          if (activeBoxTarget === 'cam') setCamBox(p => ({ ...p, height: val }));
                          else setGameBox(p => ({ ...p, height: val }));
                        }}
                        className="slider-input" 
                      />
                    </div>
                  </div>

                  {/* D-PAD com Botões de Setinha para Posicionamento Exato */}
                  <div style={{ textAlign: 'center', background: 'rgba(255, 255, 255, 0.02)', padding: '12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-card)' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '6px', fontWeight: '600' }}>
                      Setinhas de Ajuste
                    </div>
                    <div className="dpad-container">
                      <div></div>
                      <button className="dpad-btn" title="Mover para cima" onClick={() => moveBox(0, -2)}>
                        <ArrowUp size={16} />
                      </button>
                      <div></div>

                      <button className="dpad-btn" title="Mover para esquerda" onClick={() => moveBox(-2, 0)}>
                        <ArrowLeft size={16} />
                      </button>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.65rem', color: 'var(--text-dim)' }}>
                        POS
                      </div>
                      <button className="dpad-btn" title="Mover para direita" onClick={() => moveBox(2, 0)}>
                        <ArrowRight size={16} />
                      </button>

                      <div></div>
                      <button className="dpad-btn" title="Mover para baixo" onClick={() => moveBox(0, 2)}>
                        <ArrowDown size={16} />
                      </button>
                      <div></div>
                    </div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>
                      Passo de 2%
                    </div>
                  </div>
                </div>
              </div>

              {/* Painel de Câmera Dinâmica (Keyframes / Seguir Jogada) */}
              <div className="panel">
                <div className="panel-header">
                  <div className="panel-title">
                    <Compass size={18} color="var(--accent-emerald)" />
                    <span>Câmera Dinâmica (Mover e Acompanhar a Play)</span>
                  </div>
                  {gameKeyframes.length > 0 && (
                    <span style={{ fontSize: '0.75rem', background: 'rgba(16, 185, 129, 0.15)', color: '#10b981', padding: '2px 8px', borderRadius: '4px', border: '1px solid rgba(16, 185, 129, 0.3)' }}>
                      {gameKeyframes.length} ponto(s) salvo(s)
                    </span>
                  )}
                </div>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '14px' }}>
                  Quer que a câmera vire ou acompanhe a jogada? Posicione a caixa onde a ação está e salve pontos ao longo do tempo. O enquadramento se moverá suavemente entre cada ponto!
                </p>

                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                  <button 
                    type="button"
                    className="btn-primary" 
                    style={{ width: 'auto', padding: '8px 16px', fontSize: '0.82rem', background: 'linear-gradient(135deg, #10b981, #059669)' }}
                    onClick={handleAddKeyframe}
                  >
                    <Plus size={16} /> Salvar Posição aos {formatTime(currentTime)}
                  </button>
                  {hasKeyframeAtCurrent && (
                    <button 
                      type="button"
                      className="button-tab" 
                      style={{ padding: '8px 14px', fontSize: '0.8rem', borderColor: '#f43f5e', color: '#f43f5e' }}
                      onClick={handleRemoveCurrentKeyframe}
                    >
                      <Trash2 size={14} /> Remover Deste Ponto
                    </button>
                  )}
                  {gameKeyframes.length > 0 && (
                    <button 
                      type="button"
                      className="button-tab" 
                      style={{ padding: '8px 14px', fontSize: '0.8rem' }}
                      onClick={handleClearAllKeyframes}
                    >
                      Limpar Todos
                    </button>
                  )}
                </div>

                {/* Marcadores Clicáveis com os Pontos Salvos */}
                {gameKeyframes.length > 0 && (
                  <div style={{ marginTop: '14px', paddingTop: '10px', borderTop: '1px solid var(--border-card)' }}>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginBottom: '6px' }}>
                      Pontos salvos no clipe (clique para ir direto ao momento):
                    </div>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      {gameKeyframes.map((kf, i) => (
                        <button 
                          key={i}
                          type="button"
                          className="button-tab"
                          style={{ 
                            padding: '4px 10px', 
                            fontSize: '0.75rem', 
                            borderColor: Math.abs(currentTime - kf.time) < 0.35 ? 'var(--accent-emerald)' : 'var(--border-card)',
                            background: Math.abs(currentTime - kf.time) < 0.35 ? 'rgba(16, 185, 129, 0.15)' : 'rgba(255, 255, 255, 0.04)'
                          }}
                          onClick={() => {
                            if (videoRef.current) {
                              videoRef.current.currentTime = kf.time;
                              setCurrentTime(kf.time);
                            }
                          }}
                        >
                          💠 {formatTime(kf.time)} (X: {kf.x}%)
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>


            {/* Lado Direito: Preview Vertical 9:16 (Simulador de Celular) */}
            <div className="panel" style={{ position: 'sticky', top: '84px' }}>
              <div className="panel-header">
                <div className="panel-title">
                  <Smartphone size={18} color="#f43f5e" />
                  <span>Preview 9:16</span>
                </div>
                {/* Seletor de Tamanho do Celular */}
                <div className="phone-size-toggle">
                  <button 
                    type="button"
                    className={`phone-size-btn ${phoneSize === 'sm' ? 'active' : ''}`}
                    onClick={() => setPhoneSize('sm')}
                    title="Celular Normal (270px)"
                  >
                    Normal
                  </button>
                  <button 
                    type="button"
                    className={`phone-size-btn ${phoneSize === 'md' ? 'active' : ''}`}
                    onClick={() => setPhoneSize('md')}
                    title="Celular Médio (340px)"
                  >
                    Médio
                  </button>
                  <button 
                    type="button"
                    className={`phone-size-btn ${phoneSize === 'lg' ? 'active' : ''}`}
                    onClick={() => setPhoneSize('lg')}
                    title="Celular Maior (410px)"
                  >
                    Grande
                  </button>
                </div>
              </div>

              {/* Seletores de Layout */}
              <div style={{ marginBottom: '16px' }}>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: '600' }}>
                  Modelo de Enquadramento:
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
                  <button 
                    className={`button-tab ${layoutMode === 'split' ? 'active' : ''}`}
                    onClick={() => setLayoutMode('split')}
                  >
                    <Layers size={14} /> Split (Cam+Game)
                  </button>
                  <button 
                    className={`button-tab ${layoutMode === 'single_crop' ? 'active' : ''}`}
                    onClick={() => setLayoutMode('single_crop')}
                  >
                    <Scissors size={14} /> Só Vídeo (Full)
                  </button>
                </div>
                <button 
                  className={`button-tab ${layoutMode === 'blur_fit' ? 'active' : ''}`}
                  style={{ width: '100%', borderColor: layoutMode === 'blur_fit' ? 'var(--accent-cyan)' : 'var(--border-card)', marginBottom: '8px' }}
                  onClick={() => setLayoutMode('blur_fit')}
                >
                  <Sparkles size={14} color="var(--accent-cyan)" /> 🔥 LoL Shorts (Ação + Skills + Fundo Blur)
                </button>
                <button 
                  type="button"
                  className="button-tab"
                  style={{ width: '100%', background: 'rgba(99, 102, 241, 0.1)', borderColor: 'rgba(99, 102, 241, 0.5)', fontSize: '0.78rem', color: '#c7d2fe' }}
                  onClick={applyDefaultLolShorts}
                  title="Aplica 45% largura, 100% altura e Fundo Blur de uma vez só"
                >
                  ⭐ Redefinir para Padrão (45% x 100% + Blur)
                </button>
              </div>


              {/* Opção de Ligar/Desligar Facecam (conforme solicitado pelo usuário!) */}
              {layoutMode === 'split' && (
                <div className="toggle-row">
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontSize: '0.85rem', fontWeight: '600' }}>Tem Facecam no clipe?</span>
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                      {camEnabled ? 'Cam posicionada no topo' : 'Sem câmera: exibe só a gameplay centralizada'}
                    </span>
                  </div>
                  <label className="toggle-switch">
                    <input 
                      type="checkbox" 
                      checked={camEnabled} 
                      onChange={(e) => setCamEnabled(e.target.checked)} 
                    />
                    <span className="toggle-slider"></span>
                  </label>
                </div>
              )}

              {/* Slider de Altura da Câmera no modo Split */}
              {layoutMode === 'split' && camEnabled && (
                <div className="slider-group" style={{ marginBottom: '14px' }}>
                  <div className="slider-label">
                    <span>Espaço da Câmera no Topo</span>
                    <span>{camHeightPercent}%</span>
                  </div>
                  <input 
                    type="range" 
                    min="20" 
                    max="50" 
                    value={camHeightPercent}
                    onChange={(e) => setCamHeightPercent(Number(e.target.value))}
                    className="slider-input" 
                  />
                </div>
              )}

              {/* Estilo de Fundo nos Espaços Restantes */}
              <div style={{ marginBottom: '14px' }}>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '6px', fontWeight: '600' }}>
                  Fundo nos Espaços Restantes:
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                  <button 
                    type="button"
                    className={`button-tab ${bgStyle === 'blur' ? 'active' : ''}`}
                    onClick={() => setBgStyle('blur')}
                    style={{ fontSize: '0.76rem', padding: '8px 10px' }}
                  >
                    <Sparkles size={14} color="var(--accent-cyan)" /> Fundo Ofuscado (Shorts)
                  </button>
                  <button 
                    type="button"
                    className={`button-tab ${bgStyle === 'black' ? 'active' : ''}`}
                    onClick={() => setBgStyle('black')}
                    style={{ fontSize: '0.76rem', padding: '8px 10px' }}
                  >
                    ⬛ Fundo Preto
                  </button>
                </div>
              </div>

              {/* Celular Mockup com Preview ao Vivo */}
              <div className="phone-mockup-wrapper">
                <div className={`phone-mockup phone-size-${phoneSize}`}>
                  <div className="phone-notch"></div>
                  <div className="phone-content">
                    {/* Canvas renderizando O MESMO VÍDEO ao vivo a 60fps sem delay */}
                    <canvas 
                      ref={canvasRef} 
                      width={720} 
                      height={1280} 
                      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', background: '#000' }} 
                    />
                  </div>
                </div>
              </div>


              {/* Botão de Renderização */}
              <div style={{ marginTop: '20px' }}>
                <button 
                  className="btn-primary" 
                  onClick={handleStartRender}
                  disabled={renderStatus === 'queued' || renderStatus === 'processing'}
                >
                  <Download size={18} />
                  Renderizar Clipe 9:16 (Full HD)
                </button>

                {/* Card de Download Persistente */}
                {downloadUrl && (
                  <div style={{ marginTop: '14px', padding: '14px', background: 'rgba(16, 185, 129, 0.1)', border: '1px solid rgba(16, 185, 129, 0.3)', borderRadius: 'var(--radius-md)', textAlign: 'center' }}>
                    <div style={{ fontSize: '0.8rem', color: '#10b981', fontWeight: '700', marginBottom: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                      <CheckCircle size={16} /> Último Clipe Renderizado Pronto!
                    </div>
                    <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
                      <button 
                        type="button"
                        className="btn-primary" 
                        style={{ background: 'linear-gradient(135deg, #10b981, #059669)', padding: '10px 14px', fontSize: '0.85rem', width: 'auto' }}
                        onClick={() => handleDownloadVideo(downloadUrl)}
                      >
                        <Download size={16} /> Baixar MP4
                      </button>
                    </div>
                    <div style={{ marginTop: '8px', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                      ⚡ Renderizado 100% no navegador via <code style={{ color: '#10b981' }}>FFmpeg WebAssembly</code>
                    </div>
                  </div>
                )}
              </div>

            </div>
          </div>
        )}
      </main>

      {/* Modal de Progresso e Download */}
      {renderStatus && (
        <div className="modal-overlay">
          <div className="modal-content">
            {renderStatus === 'completed' ? (
              <>
                <div style={{ width: '64px', height: '64px', borderRadius: '50%', background: 'rgba(16, 185, 129, 0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px auto', color: '#10b981' }}>
                  <CheckCircle size={36} />
                </div>
                <h3 style={{ fontSize: '1.3rem', fontWeight: '800', marginBottom: '8px' }}>
                  Clipe 9:16 Pronto para Download!
                </h3>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '20px' }}>
                  O vídeo foi renderizado em 1080x1920 (9:16 vertical), codificado em H.264 pronto para postar no TikTok, Reels ou Shorts sem distorção.
                </p>

                {/* Player do resultado */}
                {downloadUrl && (
                  <div style={{ width: '180px', height: '320px', margin: '0 auto 20px auto', borderRadius: '14px', overflow: 'hidden', boxShadow: '0 10px 30px rgba(0,0,0,0.5)', background: '#000' }}>
                    <video src={downloadUrl} controls playsInline autoPlay loop style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                  </div>
                )}

                <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap', marginBottom: '14px' }}>
                  <button 
                    type="button"
                    onClick={() => handleDownloadVideo(downloadUrl)}
                    className="btn-primary" 
                    style={{ width: 'auto', padding: '12px 20px' }}
                  >
                    <Download size={18} /> Baixar Vídeo MP4
                  </button>
                  <button 
                    type="button"
                    className="button-tab" 
                    style={{ padding: '12px 16px' }} 
                    onClick={() => {
                      setRenderStatus(null);
                    }}
                  >
                    Fechar
                  </button>
                </div>
                <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', background: 'rgba(255, 255, 255, 0.04)', padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border-card)' }}>
                  🔒 <strong>Zero Upload:</strong> O vídeo foi processado 100% no seu dispositivo via WebAssembly.
                </div>
              </>
            ) : renderStatus === 'failed' ? (
              <>
                <div style={{ width: '64px', height: '64px', borderRadius: '50%', background: 'rgba(244, 63, 94, 0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px auto', color: '#f43f5e' }}>
                  <AlertCircle size={36} />
                </div>
                <h3 style={{ fontSize: '1.2rem', fontWeight: '800', marginBottom: '8px' }}>
                  Erro ao Processar o Vídeo
                </h3>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '20px' }}>
                  {renderError || 'Ocorreu um problema ao compilar com o FFmpeg.'}
                </p>
                <button className="btn-primary" onClick={() => setRenderStatus(null)}>
                  Voltar e Tentar Novamente
                </button>
              </>
            ) : (
              <>
                <div style={{ width: '64px', height: '64px', borderRadius: '50%', background: 'rgba(99, 102, 241, 0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px auto', color: 'var(--primary)' }}>
                  <RefreshCw size={32} className="spin-animation" style={{ animation: 'spin 1.5s linear infinite' }} />
                </div>
                <h3 style={{ fontSize: '1.25rem', fontWeight: '800', marginBottom: '8px' }}>
                  Renderizando seu Clipe em 9:16...
                </h3>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.88rem' }}>
                  Processando enquadramentos e filtros via FFmpeg WebAssembly na sua máquina.
                </p>
                <div className="progress-bar-bg">
                  <div className="progress-bar-fill" style={{ width: `${renderProgress}%` }}></div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', fontSize: '0.8rem', color: 'var(--text-dim)', marginTop: '4px' }}>
                  <span>{renderLog || 'Processando vídeo...'}</span>
                  <span style={{ fontWeight: '700', color: '#818cf8' }}>{renderProgress}%</span>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
