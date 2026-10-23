import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  Upload, Film, Smartphone, Sliders, Scissors, Play, Pause, 
  ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Download, CheckCircle, 
  AlertCircle, RefreshCw, Layers, Eye, Video,
  Plus, Trash2, Camera, Gamepad2, Shield, Settings2, SlidersHorizontal,
  FolderOpen, Cpu, Grid3X3, Maximize2, Move
} from 'lucide-react';
import { extractVideoMetadata, renderVideoClientSide } from './services/videoRenderer';

export default function App() {
  const [videoFile, setVideoFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState(null);
  const [uploadedData, setUploadedData] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);

  // Arquitetura de Camadas: 'manual' (atual) ou 'auto' (futuro)
  const [pipelineMode, setPipelineMode] = useState('manual');

  // Modo Mobile: aba ativa na tela do celular
  const [mobileTab, setMobileTab] = useState('preview'); // 'preview' | 'crop' | 'motion' | 'settings'

  // Guia de Segurança de Redes Sociais (TikTok / Reels Safe Zone)
  const [showSocialGuide, setShowSocialGuide] = useState(false);

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
  const [bgStyle, setBgStyle] = useState('blur'); // 'blur' ou 'black'

  // Estado de renderização Client-Side
  const [renderStatus, setRenderStatus] = useState(null); // 'processing', 'completed', 'failed'
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderLog, setRenderLog] = useState('');
  const [downloadUrl, setDownloadUrl] = useState(null);
  const [renderError, setRenderError] = useState(null);

  // Tamanho do Preview do Celular: 'sm' (270px), 'md' (340px), 'lg' (400px)
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
  const isDraggingRef = useRef(null);
  const dragStartRef = useRef({ x: 0, y: 0, boxX: 0, boxY: 0 });

  // Formatar segundos em 00:00.0
  const formatTime = (secs) => {
    if (isNaN(secs) || secs < 0) return '00:00.0';
    const m = Math.floor(secs / 60);
    const s = (secs % 60).toFixed(1);
    const sStr = Number(s) < 10 ? `0${s}` : s;
    return `${m < 10 ? '0' : ''}${m}:${sStr}`;
  };

  // Controlar play/pause
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

  // Interpolação matemática entre keyframes
  const getInterpolatedBox = useCallback((keyframes, baseBox, t) => {
    if (!keyframes || keyframes.length === 0) return baseBox;
    if (keyframes.length === 1) return { ...baseBox, x: keyframes[0].x, y: keyframes[0].y };

    const sorted = [...keyframes].sort((a, b) => a.time - b.time);
    if (t <= sorted[0].time) return { ...baseBox, x: sorted[0].x, y: sorted[0].y };
    if (t >= sorted[sorted.length - 1].time) {
      const last = sorted[sorted.length - 1];
      return { ...baseBox, x: last.x, y: last.y };
    }

    let i = 0;
    while (i < sorted.length - 1 && sorted[i + 1].time < t) i++;
    const k0 = sorted[i];
    const k1 = sorted[i + 1];
    const alpha = (t - k0.time) / (k1.time - k0.time);
    const ease = alpha * alpha * (3 - 2 * alpha); // Smoothstep

    return {
      ...baseBox,
      x: Number((k0.x + (k1.x - k0.x) * ease).toFixed(1)),
      y: Number((k0.y + (k1.y - k0.y) * ease).toFixed(1))
    };
  }, []);

  // Adicionar ponto de câmera no segundo atual
  const handleAddKeyframe = () => {
    const curX = gameBox.x;
    const curY = gameBox.y;
    const t = Number(currentTime.toFixed(2));

    setGameKeyframes(prev => {
      const filtered = prev.filter(k => Math.abs(k.time - t) > 0.15);
      const updated = [...filtered, { time: t, x: curX, y: curY }];
      return updated.sort((a, b) => a.time - b.time);
    });
  };

  const handleRemoveCurrentKeyframe = () => {
    const t = currentTime;
    setGameKeyframes(prev => prev.filter(k => Math.abs(k.time - t) > 0.35));
  };

  const handleClearAllKeyframes = () => {
    if (confirm('Deseja remover todos os pontos dinâmicos de câmera?')) {
      setGameKeyframes([]);
    }
  };

  const hasKeyframeAtCurrent = gameKeyframes.some(k => Math.abs(k.time - currentTime) < 0.35);

  // Renderizador do Canvas ao Vivo (Preview 9:16)
  useEffect(() => {
    let animId;
    const renderCanvas = () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.readyState >= 2) {
        const ctx = canvas.getContext('2d');
        const cw = canvas.width;
        const ch = canvas.height;
        const vw = video.videoWidth || 1920;
        const vh = video.videoHeight || 1080;

        ctx.fillStyle = '#0b0d13';
        ctx.fillRect(0, 0, cw, ch);

        // Fundo Blur
        if (layoutMode === 'blur_fit' && bgStyle === 'blur') {
          ctx.save();
          ctx.filter = `blur(${blurIntensity}px) brightness(0.65)`;
          const scale = Math.max(cw / vw, ch / vh);
          const bgW = vw * scale;
          const bgH = vh * scale;
          const bgX = (cw - bgW) / 2;
          const bgY = (ch - bgH) / 2;
          ctx.drawImage(video, bgX, bgY, bgW, bgH);
          ctx.restore();
        }

        const curGame = isDraggingRef.current === 'game' 
          ? gameBox 
          : getInterpolatedBox(gameKeyframes, gameBox, video.currentTime);

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

          drawPreserveAspect(camBox.x, camBox.y, camBox.width, camBox.height, 0, 0, cw, camH);

          if (showDivider) {
            ctx.fillStyle = '#4f46e5';
            ctx.fillRect(0, camH - 2, cw, 4);
          }

          drawPreserveAspect(curGame.x, curGame.y, curGame.width, curGame.height, 0, camH, cw, gameH);

        } else if (layoutMode === 'blur_fit') {
          const gsx = (curGame.x / 100) * vw;
          const gsy = (curGame.y / 100) * vh;
          const gsw = Math.max(2, (curGame.width / 100) * vw);
          const gsh = Math.max(2, (curGame.height / 100) * vh);

          const fgW = cw;
          const fgH = cw * (gsh / gsw);
          const fgY = (ch - fgH) / 2;

          ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
          ctx.shadowBlur = 16;
          ctx.drawImage(video, gsx, gsy, gsw, gsh, 0, fgY, fgW, fgH);
          ctx.shadowColor = 'transparent';
          ctx.shadowBlur = 0;

        } else {
          drawPreserveAspect(curGame.x, curGame.y, curGame.width, curGame.height, 0, 0, cw, ch);
        }
      }
      animId = requestAnimationFrame(renderCanvas);
    };

    animId = requestAnimationFrame(renderCanvas);
    return () => cancelAnimationFrame(animId);
  }, [layoutMode, camEnabled, camBox, gameBox, gameKeyframes, camHeightPercent, showDivider, isPlaying, bgStyle, blurIntensity, getInterpolatedBox]);

  // Upload do arquivo
  const handleFileUpload = async (file) => {
    if (!file) return;
    setIsUploading(true);
    try {
      const localBlob = URL.createObjectURL(file);
      setVideoUrl(localBlob);
      setVideoFile(file);

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
      alert('Não foi possível ler o arquivo selecionado.');
    } finally {
      setIsUploading(false);
    }
  };

  // Carregar vídeo demo
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
      alert('Vídeo demo não encontrado.');
    } finally {
      setIsUploading(false);
    }
  };

  // Movimentação
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

  // Renderização Client-Side
  const handleStartRender = async () => {
    if (!uploadedData && !videoFile) {
      alert('Por favor, carregue um clipe primeiro.');
      return;
    }

    setRenderStatus('processing');
    setRenderProgress(5);
    setRenderLog('Inicializando motor WebAssembly...');
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
          setRenderLog(`Renderizando clipe no dispositivo... ${pct}%`);
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
      console.error('Erro na renderização:', err);
      setRenderStatus('failed');
      setRenderError(err.message || 'Erro durante a renderização.');
    }
  };

  // Download imediato
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

  // Preset LoL Shorts (45% x 100% centralizado + blur)
  const applyDefaultLolShorts = () => {
    setLayoutMode('blur_fit');
    setBgStyle('blur');
    setGameBox({
      x: 27.5,
      y: 0,
      width: 45,
      height: 100
    });
    setActiveBoxTarget('game');
  };

  // Drag & drop no canvas original
  const handleMouseDown = (e, boxType) => {
    e.stopPropagation();
    isDraggingRef.current = boxType;
    setActiveBoxTarget(boxType);
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
    const stageRect = stageRef.current.getBoundingClientRect();
    const dx = ((e.clientX - dragStartRef.current.x) / stageRect.width) * 100;
    const dy = ((e.clientY - dragStartRef.current.y) / stageRect.height) * 100;

    const isCam = isDraggingRef.current === 'cam';
    const target = isCam ? camBox : gameBox;
    const setTarget = isCam ? setCamBox : setGameBox;

    const newX = Math.max(0, Math.min(100 - target.width, dragStartRef.current.boxX + dx));
    const newY = Math.max(0, Math.min(100 - target.height, dragStartRef.current.boxY + dy));

    setTarget(prev => ({
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
      
      {/* Header Studio */}
      <header className="app-header">
        <div className="brand-wrapper">
          <div className="brand-icon">
            <Video size={16} />
          </div>
          <span className="brand-name">ClipGames Studio</span>
          <span className="brand-badge">9:16 Workstation</span>
        </div>

        {/* Camadas do Editor */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ display: 'inline-flex', background: 'var(--bg-app)', border: '1px solid var(--border-subtle)', borderRadius: '6px', padding: '2px' }}>
            <button 
              type="button" 
              onClick={() => setPipelineMode('manual')}
              style={{
                background: pipelineMode === 'manual' ? 'var(--bg-surface-elevated)' : 'transparent',
                border: pipelineMode === 'manual' ? '1px solid var(--border-medium)' : 'none',
                color: pipelineMode === 'manual' ? '#fff' : 'var(--text-secondary)',
                fontSize: '0.74rem',
                fontWeight: '600',
                padding: '4px 10px',
                borderRadius: '4px',
                cursor: 'pointer'
              }}
            >
              Enquadramento Manual
            </button>
            <button 
              type="button"
              onClick={() => alert('A camada de Recorte Automático com IA está em desenvolvimento e estará disponível na próxima atualização!')}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--text-tertiary)',
                fontSize: '0.74rem',
                fontWeight: '600',
                padding: '4px 10px',
                borderRadius: '4px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px'
              }}
            >
              <span>Auto-Clip</span>
              <span style={{ fontSize: '0.62rem', background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: '3px' }}>Em Breve</span>
            </button>
          </div>

          {uploadedData && (
            <button 
              type="button"
              onClick={() => {
                setVideoUrl(null);
                setUploadedData(null);
              }}
              className="btn-studio-secondary"
              style={{ fontSize: '0.74rem', padding: '4px 10px', minHeight: '30px' }}
            >
              <RefreshCw size={13} /> Trocar Vídeo
            </button>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main className="main-layout" style={{ flex: 1 }}>
        {!videoUrl ? (
          /* Tela Inicial de Upload */
          <div className="upload-hero">
            <div 
              className="upload-dropzone"
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
              <div className="upload-icon-circle">
                <Upload size={28} />
              </div>
              <h2 style={{ fontSize: '1.25rem', fontWeight: '700', marginBottom: '8px' }}>
                Selecione ou arraste seu clipe 16:9
              </h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.88rem', maxWidth: '460px', margin: '0 auto 20px auto' }}>
                Formate e converta gameplays para formato vertical 9:16 (Shorts, Reels, TikTok) com enquadramento de Facecam e Pan & Scan dinâmico.
              </p>
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap' }}>
                <button type="button" className="btn-studio-primary" style={{ width: 'auto' }}>
                  <Film size={16} /> Selecionar Arquivo de Vídeo
                </button>
                <button 
                  type="button"
                  className="btn-studio-secondary" 
                  onClick={(e) => {
                    e.stopPropagation();
                    handleLoadDemo();
                  }}
                >
                  Carregar Vídeo Demo (LoL)
                </button>
              </div>
            </div>

            <div style={{ marginTop: '24px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px', textAlign: 'left' }}>
              <div className="studio-panel" style={{ padding: '16px' }}>
                <div style={{ color: 'var(--cam-color)', marginBottom: '6px' }}><Camera size={20} /></div>
                <div style={{ fontSize: '0.85rem', fontWeight: '600', marginBottom: '4px' }}>Split com Facecam</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Câmera posicionada no topo com corte exato da gameplay embaixo.</div>
              </div>
              <div className="studio-panel" style={{ padding: '16px' }}>
                <div style={{ color: 'var(--game-color)', marginBottom: '6px' }}><Gamepad2 size={20} /></div>
                <div style={{ fontSize: '0.85rem', fontWeight: '600', marginBottom: '4px' }}>Preset Ação Central + Blur</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Enquadra kills e habilidades no centro com fundo desfocado atrás.</div>
              </div>
              <div className="studio-panel" style={{ padding: '16px' }}>
                <div style={{ color: '#a5b4fc', marginBottom: '6px' }}><Move size={20} /></div>
                <div style={{ fontSize: '0.85rem', fontWeight: '600', marginBottom: '4px' }}>Câmera Dinâmica (Pan & Scan)</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Acompanha o movimento do campeão ou do cursor pela tela.</div>
              </div>
            </div>
          </div>
        ) : (
          /* Workspace Studio */
          <div>
            {/* Barra de Abas Mobile (Aparece apenas em telas pequenas < 1024px) */}
            <div className="mobile-tabs-bar">
              <button 
                type="button" 
                className={`mobile-tab-btn ${mobileTab === 'preview' ? 'active' : ''}`}
                onClick={() => setMobileTab('preview')}
              >
                <Smartphone size={15} /> Preview 9:16
              </button>
              <button 
                type="button" 
                className={`mobile-tab-btn ${mobileTab === 'crop' ? 'active' : ''}`}
                onClick={() => setMobileTab('crop')}
              >
                <Grid3X3 size={15} /> Enquadramento
              </button>
              <button 
                type="button" 
                className={`mobile-tab-btn ${mobileTab === 'motion' ? 'active' : ''}`}
                onClick={() => setMobileTab('motion')}
              >
                <Scissors size={15} /> Timeline
              </button>
              <button 
                type="button" 
                className={`mobile-tab-btn ${mobileTab === 'settings' ? 'active' : ''}`}
                onClick={() => setMobileTab('settings')}
              >
                <Settings2 size={15} /> Layout
              </button>
            </div>

            <div className="studio-grid">
              
              {/* Coluna Esquerda: Stage 16:9 + Controles de Enquadramento + Timeline */}
              <div style={{ 
                display: (mobileTab === 'crop' || mobileTab === 'motion' || window.innerWidth >= 1024) ? 'flex' : 'none', 
                flexDirection: 'column', 
                gap: '16px' 
              }}>
                
                {/* Stage 16:9 de Recorte */}
                <div className="studio-panel" style={{ display: (mobileTab === 'crop' || window.innerWidth >= 1024) ? 'block' : 'none' }}>
                  <div className="panel-header-clean">
                    <span className="panel-title-clean">
                      <Film size={15} color="var(--game-color)" /> Vídeo de Origem (16:9)
                    </span>
                    <span style={{ fontSize: '0.72rem', fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>
                      Arraste as caixas para enquadrar
                    </span>
                  </div>

                  <div className="stage-container" ref={stageRef}>
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

                    {/* Caixa 1: Câmera */}
                    {layoutMode === 'split' && camEnabled && (
                      <div 
                        className={`stage-crop-box box-cam ${activeBoxTarget === 'cam' ? 'active-selection' : ''}`}
                        style={{
                          left: `${camBox.x}%`,
                          top: `${camBox.y}%`,
                          width: `${camBox.width}%`,
                          height: `${camBox.height}%`
                        }}
                        onMouseDown={(e) => handleMouseDown(e, 'cam')}
                      >
                        <span className="box-tag">Facecam</span>
                      </div>
                    )}

                    {/* Caixa 2: Gameplay */}
                    {(() => {
                      const curDisplayGame = (isDraggingRef.current === 'game' || gameKeyframes.length === 0)
                        ? gameBox
                        : getInterpolatedBox(gameKeyframes, gameBox, currentTime);
                      return (
                        <div 
                          className={`stage-crop-box box-game ${activeBoxTarget === 'game' ? 'active-selection' : ''}`}
                          style={{
                            left: `${curDisplayGame.x}%`,
                            top: `${curDisplayGame.y}%`,
                            width: `${curDisplayGame.width}%`,
                            height: `${curDisplayGame.height}%`
                          }}
                          onMouseDown={(e) => handleMouseDown(e, 'game')}
                        >
                          <span className="box-tag">Gameplay</span>
                        </div>
                      );
                    })()}
                  </div>

                  {/* Player & Scrubber */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '12px', flexWrap: 'wrap' }}>
                    <button 
                      type="button"
                      onClick={togglePlay}
                      className="btn-studio-secondary"
                      style={{ minHeight: '36px', padding: '6px 12px' }}
                    >
                      {isPlaying ? <Pause size={15} /> : <Play size={15} />}
                    </button>
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
                      className="timeline-slider"
                      style={{ flex: 1, minWidth: '160px' }}
                    />
                    <span style={{ fontSize: '0.78rem', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                      {formatTime(currentTime)} / {formatTime(videoDuration)}
                    </span>
                  </div>
                </div>

                {/* Painel de Posicionamento Fino & D-Pad */}
                <div className="studio-panel" style={{ display: (mobileTab === 'crop' || window.innerWidth >= 1024) ? 'block' : 'none' }}>
                  <div className="panel-header-clean">
                    <span className="panel-title-clean">
                      <Sliders size={15} color="var(--cam-color)" /> Ajuste da Posição
                    </span>
                    {layoutMode === 'split' && camEnabled && (
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <button 
                          type="button"
                          className={`btn-studio-secondary ${activeBoxTarget === 'game' ? 'active' : ''}`}
                          onClick={() => setActiveBoxTarget('game')}
                          style={{ fontSize: '0.74rem', padding: '4px 8px', minHeight: '30px' }}
                        >
                          Gameplay
                        </button>
                        <button 
                          type="button"
                          className={`btn-studio-secondary ${activeBoxTarget === 'cam' ? 'active' : ''}`}
                          onClick={() => setActiveBoxTarget('cam')}
                          style={{ fontSize: '0.74rem', padding: '4px 8px', minHeight: '30px' }}
                        >
                          Facecam
                        </button>
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '16px', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                        Tamanho do recorte ({activeBoxTarget === 'cam' ? camBox.width : gameBox.width}% larg × {activeBoxTarget === 'cam' ? camBox.height : gameBox.height}% alt):
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        <div>
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
                            className="timeline-slider" 
                          />
                        </div>
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                          <button type="button" className="btn-studio-secondary" style={{ fontSize: '0.72rem', padding: '4px 8px', minHeight: '30px' }} onClick={applyDefaultLolShorts}>
                            Preset LoL Central
                          </button>
                          <button type="button" className="btn-studio-secondary" style={{ fontSize: '0.72rem', padding: '4px 8px', minHeight: '30px' }} onClick={() => setGameBox({ x: 14, y: 12, width: 72, height: 86 })}>
                            Preset Ação + HUD
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* D-Pad com botões de 44px ideais para toque */}
                    <div className="touch-control-grid">
                      <div></div>
                      <button type="button" className="touch-btn" onClick={() => moveBox(0, -2)} title="Cima"><ArrowUp size={16} /></button>
                      <div></div>
                      <button type="button" className="touch-btn" onClick={() => moveBox(-2, 0)} title="Esquerda"><ArrowLeft size={16} /></button>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.62rem', fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>POS</div>
                      <button type="button" className="touch-btn" onClick={() => moveBox(2, 0)} title="Direita"><ArrowRight size={16} /></button>
                      <div></div>
                      <button type="button" className="touch-btn" onClick={() => moveBox(0, 2)} title="Baixo"><ArrowDown size={16} /></button>
                      <div></div>
                    </div>
                  </div>
                </div>

                {/* Painel de Trim & Keyframes (Timeline) */}
                <div className="studio-panel" style={{ display: (mobileTab === 'motion' || window.innerWidth >= 1024) ? 'block' : 'none' }}>
                  <div className="panel-header-clean">
                    <span className="panel-title-clean">
                      <Scissors size={15} color="#10b981" /> Corte de Duração (Trim)
                    </span>
                    <span style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: '#10b981' }}>
                      {(trimEnd > trimStart ? trimEnd - trimStart : (videoDuration || 0)).toFixed(1)}s de clipe
                    </span>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '14px' }}>
                    <div style={{ background: 'var(--bg-app)', padding: '10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.74rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                        <span>Início</span>
                        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{formatTime(trimStart)}</span>
                      </div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <input 
                          type="range"
                          min="0"
                          max={Math.max(0, (trimEnd || videoDuration) - 0.5)}
                          step="0.1"
                          value={trimStart}
                          onChange={(e) => setTrimStart(Number(e.target.value))}
                          className="timeline-slider"
                        />
                        <button type="button" className="btn-studio-secondary" style={{ fontSize: '0.7rem', padding: '4px 8px', minHeight: '30px' }} onClick={() => setTrimStart(currentTime)}>
                          Fixar
                        </button>
                      </div>
                    </div>

                    <div style={{ background: 'var(--bg-app)', padding: '10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.74rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                        <span>Fim</span>
                        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{formatTime(trimEnd || videoDuration)}</span>
                      </div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <input 
                          type="range"
                          min={Math.min(videoDuration, trimStart + 0.5)}
                          max={videoDuration || 100}
                          step="0.1"
                          value={trimEnd || videoDuration}
                          onChange={(e) => setTrimEnd(Number(e.target.value))}
                          className="timeline-slider"
                        />
                        <button type="button" className="btn-studio-secondary" style={{ fontSize: '0.7rem', padding: '4px 8px', minHeight: '30px' }} onClick={() => setTrimEnd(currentTime)}>
                          Fixar
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Keyframes de Movimento */}
                  <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                      <span style={{ fontSize: '0.8rem', fontWeight: '600' }}>Pontos de Pan & Scan</span>
                      <button 
                        type="button" 
                        className="btn-studio-secondary" 
                        style={{ fontSize: '0.74rem', padding: '4px 10px', minHeight: '30px' }}
                        onClick={handleAddKeyframe}
                      >
                        <Plus size={13} /> Salvar Posição em {formatTime(currentTime)}
                      </button>
                    </div>

                    {gameKeyframes.length > 0 ? (
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        {gameKeyframes.map((kf, i) => (
                          <button 
                            key={i} 
                            type="button" 
                            className="btn-studio-secondary"
                            style={{ 
                              fontSize: '0.72rem', 
                              padding: '3px 8px', 
                              minHeight: '26px',
                              borderColor: Math.abs(currentTime - kf.time) < 0.35 ? '#10b981' : 'var(--border-subtle)' 
                            }}
                            onClick={() => {
                              if (videoRef.current) {
                                videoRef.current.currentTime = kf.time;
                                setCurrentTime(kf.time);
                              }
                            }}
                          >
                            Ponto {i + 1} ({formatTime(kf.time)})
                          </button>
                        ))}
                        <button type="button" className="btn-studio-secondary" style={{ fontSize: '0.72rem', padding: '3px 8px', minHeight: '26px', color: '#f43f5e' }} onClick={handleClearAllKeyframes}>
                          Limpar
                        </button>
                      </div>
                    ) : (
                      <span style={{ fontSize: '0.74rem', color: 'var(--text-tertiary)' }}>Nenhum ponto dinâmico salvo. O enquadramento permanecerá fixo.</span>
                    )}
                  </div>
                </div>

              </div>

              {/* Coluna Direita: Preview Vertical 9:16 + Layouts + Exportar */}
              <div style={{ 
                display: (mobileTab === 'preview' || mobileTab === 'settings' || window.innerWidth >= 1024) ? 'flex' : 'none', 
                flexDirection: 'column', 
                gap: '16px' 
              }}>

                <div className="studio-panel preview-card">
                  <div className="panel-header-clean" style={{ width: '100%' }}>
                    <span className="panel-title-clean">
                      <Smartphone size={15} color="#38bdf8" /> Preview 9:16
                    </span>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button 
                        type="button"
                        className={`btn-studio-secondary ${showSocialGuide ? 'active' : ''}`}
                        onClick={() => setShowSocialGuide(!showSocialGuide)}
                        style={{ fontSize: '0.72rem', padding: '3px 8px', minHeight: '28px' }}
                        title="Ativar contorno de botões do TikTok / Reels para checar área segura"
                      >
                        <Shield size={12} /> Guia Redes
                      </button>
                      <button 
                        type="button"
                        className={`btn-studio-secondary ${phoneSize === 'sm' ? 'active' : ''}`}
                        onClick={() => setPhoneSize('sm')}
                        style={{ fontSize: '0.72rem', padding: '3px 6px', minHeight: '28px' }}
                      >
                        P
                      </button>
                      <button 
                        type="button"
                        className={`btn-studio-secondary ${phoneSize === 'md' ? 'active' : ''}`}
                        onClick={() => setPhoneSize('md')}
                        style={{ fontSize: '0.72rem', padding: '3px 6px', minHeight: '28px' }}
                      >
                        M
                      </button>
                    </div>
                  </div>

                  {/* Viewport do Celular 9:16 */}
                  <div 
                    className="phone-viewport" 
                    style={{ 
                      width: phoneSize === 'sm' ? '240px' : phoneSize === 'md' ? '290px' : '340px',
                      maxWidth: '100%'
                    }}
                  >
                    <canvas 
                      ref={canvasRef} 
                      width={720} 
                      height={1280} 
                      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', background: '#000' }} 
                    />

                    {/* Guia Visual de Área Segura TikTok/Shorts */}
                    {showSocialGuide && (
                      <div className="social-overlay-guide">
                        <div style={{ fontSize: '0.62rem', color: 'rgba(255,255,255,0.7)', background: 'rgba(0,0,0,0.5)', padding: '2px 6px', borderRadius: '3px', alignSelf: 'flex-start' }}>
                          Área Segura (Safe Zone)
                        </div>
                        <div className="social-sidebar-mock">
                          <div className="social-btn-mock" />
                          <div className="social-btn-mock" />
                          <div className="social-btn-mock" />
                        </div>
                        <div className="social-caption-mock" />
                      </div>
                    )}
                  </div>
                </div>

                {/* Configurações de Layout & Composição */}
                <div className="studio-panel" style={{ display: (mobileTab === 'settings' || window.innerWidth >= 1024) ? 'block' : 'none' }}>
                  <div className="panel-header-clean">
                    <span className="panel-title-clean">
                      <Layers size={15} color="var(--action-primary)" /> Composição Vertical
                    </span>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px', marginBottom: '12px' }}>
                    <button 
                      type="button" 
                      className={`btn-studio-secondary ${layoutMode === 'split' ? 'active' : ''}`}
                      onClick={() => setLayoutMode('split')}
                      style={{ fontSize: '0.74rem', padding: '8px 4px' }}
                    >
                      Split (Cam)
                    </button>
                    <button 
                      type="button" 
                      className={`btn-studio-secondary ${layoutMode === 'blur_fit' ? 'active' : ''}`}
                      onClick={() => setLayoutMode('blur_fit')}
                      style={{ fontSize: '0.74rem', padding: '8px 4px' }}
                    >
                      Fit + Blur
                    </button>
                    <button 
                      type="button" 
                      className={`btn-studio-secondary ${layoutMode === 'single_crop' ? 'active' : ''}`}
                      onClick={() => setLayoutMode('single_crop')}
                      style={{ fontSize: '0.74rem', padding: '8px 4px' }}
                    >
                      9:16 Direto
                    </button>
                  </div>

                  {layoutMode === 'split' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Facecam ativa</span>
                        <input 
                          type="checkbox" 
                          checked={camEnabled} 
                          onChange={(e) => setCamEnabled(e.target.checked)} 
                        />
                      </div>
                      {camEnabled && (
                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.74rem', color: 'var(--text-secondary)', marginBottom: '2px' }}>
                            <span>Espaço da Câmera</span>
                            <span style={{ fontFamily: 'var(--font-mono)' }}>{camHeightPercent}%</span>
                          </div>
                          <input 
                            type="range" 
                            min="20" 
                            max="50" 
                            value={camHeightPercent}
                            onChange={(e) => setCamHeightPercent(Number(e.target.value))}
                            className="timeline-slider" 
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {layoutMode === 'blur_fit' && (
                    <div style={{ display: 'flex', gap: '6px', marginBottom: '12px' }}>
                      <button 
                        type="button"
                        className={`btn-studio-secondary ${bgStyle === 'blur' ? 'active' : ''}`}
                        onClick={() => setBgStyle('blur')}
                        style={{ flex: 1, fontSize: '0.74rem', minHeight: '32px' }}
                      >
                        Fundo Desfocado
                      </button>
                      <button 
                        type="button"
                        className={`btn-studio-secondary ${bgStyle === 'black' ? 'active' : ''}`}
                        onClick={() => setBgStyle('black')}
                        style={{ flex: 1, fontSize: '0.74rem', minHeight: '32px' }}
                      >
                        Fundo Preto
                      </button>
                    </div>
                  )}

                  {/* Botão de Renderização */}
                  <button 
                    type="button" 
                    className="btn-studio-primary" 
                    onClick={handleStartRender}
                    disabled={renderStatus === 'processing'}
                    style={{ background: 'linear-gradient(135deg, #10b981, #059669)', border: 'none', marginTop: '6px' }}
                  >
                    <Download size={16} /> Renderizar Clipe 9:16 (Full HD)
                  </button>

                  {/* Card de Download Rápido */}
                  {downloadUrl && (
                    <div style={{ marginTop: '12px', padding: '12px', background: 'rgba(16, 185, 129, 0.08)', border: '1px solid rgba(16, 185, 129, 0.25)', borderRadius: 'var(--radius-sm)', textAlign: 'center' }}>
                      <div style={{ fontSize: '0.78rem', color: '#10b981', fontWeight: '600', marginBottom: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                        <CheckCircle size={14} /> Clipe pronto para salvar
                      </div>
                      <button 
                        type="button" 
                        className="btn-studio-primary" 
                        style={{ background: '#10b981', minHeight: '36px', fontSize: '0.8rem' }}
                        onClick={() => handleDownloadVideo(downloadUrl)}
                      >
                        <Download size={14} /> Baixar Vídeo MP4
                      </button>
                    </div>
                  )}
                </div>

              </div>

            </div>
          </div>
        )}
      </main>

      {/* Modal de Progresso e Conclusão */}
      {renderStatus && (
        <div className="studio-modal-backdrop">
          <div className="studio-modal-box">
            {renderStatus === 'completed' ? (
              <>
                <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: 'rgba(16, 185, 129, 0.15)', color: '#10b981', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px auto' }}>
                  <CheckCircle size={28} />
                </div>
                <h3 style={{ fontSize: '1.15rem', fontWeight: '700', marginBottom: '6px' }}>
                  Clipe Renderizado com Sucesso
                </h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', marginBottom: '16px' }}>
                  Vídeo vertical em 1080x1920 codificado em H.264 pronto para redes sociais.
                </p>

                {downloadUrl && (
                  <div style={{ width: '160px', height: '284px', margin: '0 auto 16px auto', borderRadius: '12px', overflow: 'hidden', background: '#000', border: '1px solid var(--border-medium)' }}>
                    <video src={downloadUrl} controls playsInline autoPlay loop style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                  </div>
                )}

                <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
                  <button type="button" className="btn-studio-primary" style={{ width: 'auto' }} onClick={() => handleDownloadVideo(downloadUrl)}>
                    <Download size={16} /> Baixar MP4
                  </button>
                  <button type="button" className="btn-studio-secondary" onClick={() => setRenderStatus(null)}>
                    Fechar
                  </button>
                </div>
              </>
            ) : renderStatus === 'failed' ? (
              <>
                <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: 'rgba(244, 63, 94, 0.15)', color: '#f43f5e', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px auto' }}>
                  <AlertCircle size={28} />
                </div>
                <h3 style={{ fontSize: '1.1rem', fontWeight: '700', marginBottom: '6px' }}>
                  Erro na Renderização
                </h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', marginBottom: '16px' }}>
                  {renderError || 'Ocorreu uma falha durante o processamento do vídeo.'}
                </p>
                <button type="button" className="btn-studio-primary" onClick={() => setRenderStatus(null)}>
                  Tentar Novamente
                </button>
              </>
            ) : (
              <>
                <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: 'rgba(56, 189, 248, 0.1)', color: '#38bdf8', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px auto' }}>
                  <RefreshCw size={24} style={{ animation: 'spin 1.2s linear infinite' }} />
                </div>
                <h3 style={{ fontSize: '1.15rem', fontWeight: '700', marginBottom: '6px' }}>
                  Renderizando Clipe 9:16
                </h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
                  Processamento direto no seu navegador via WebAssembly.
                </p>
                <div className="progress-bar-minimal">
                  <div className="progress-bar-minimal-fill" style={{ width: `${renderProgress}%` }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  <span>{renderLog || 'Processando frames...'}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: '600', color: '#38bdf8' }}>{renderProgress}%</span>
                </div>
              </>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
