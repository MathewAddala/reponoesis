import { useEffect, useRef, useState } from 'react';

// ─── Interfaces ───────────────────────────────────────────────────────────────

interface FileNode {
  id: string;
  path: string;
  kind: string;
  contentHash: string;
  sectionCount: number;
}

interface SectionNode {
  id: string;
  fileId: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  contentHash: string;
  rawText: string;
  kind: string;
}

interface ConceptNode {
  id: string;
  label: string;
  canonical: string;
  sectionId: string;
  fileId: string;
  confidence: string;
  chainLink: string;
  chainState: 'VALID' | 'CHAIN_BROKEN' | 'ACKNOWLEDGED_DRIFT';
  brokenAt: number | null;
}

interface EdgeLink {
  id: string;
  fromId: string;
  toId: string;
  edgeType: string;
  weight: number;
  evidence: {
    reason: string;
    symbol?: string;
    lineRef?: number;
    sourceAnalysis: string;
  };
}

interface SemanticViolation {
  id: string;
  conceptLabel: string;
  fileAId: string;
  sectionAId: string;
  fileBId: string;
  sectionBId: string;
  reason: string;
  proposedFix: string;
  severity: string;
  createdAt: number;
  fileAPath: string;
  fileBPath: string;
  lineStartA: number;
  lineEndA: number;
  lineStartB: number;
  lineEndB: number;
}

interface GraphData {
  files: FileNode[];
  sections: SectionNode[];
  concepts: ConceptNode[];
  edges: EdgeLink[];
  health: {
    totalConcepts: number;
    brokenChains: number;
    acknowledgedDrift: number;
    validChains: number;
    totalEdges: number;
    totalFiles: number;
  };
  decisions?: Array<{
    id: string;
    label: string;
    title: string;
    status: string;
    body: string;
    createdAt: number;
    updatedAt: number;
  }>;
  decisionLinks?: Array<{
    decisionId: string;
    sectionId: string;
    fileId: string;
    chainLink: string;
    chainState: 'VALID' | 'CHAIN_BROKEN' | 'ACKNOWLEDGED_DRIFT';
    driftExplanation?: string;
  }>;
  semanticViolations?: SemanticViolation[];
}

interface GraphNode {
  id: string;
  label: string;
  type: 'file' | 'section' | 'concept' | 'decision';
  status: 'VALID' | 'CHAIN_BROKEN' | 'ACKNOWLEDGED_DRIFT';
  filePath: string;
  rawText?: string;
  lineRange?: string;
  chainLink?: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  decisionTitle?: string;
  decisionStatus?: string;
  decisionBody?: string;
}

interface GraphEdge {
  id: string;
  from: GraphNode;
  to: GraphNode;
  type: string;
  weight: number;
  reason: string;
}

// ─── PCB Trace Routing Helpers ──────────────────────────────────────────────────

const drawPCBTrace = (ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) => {
  if (isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2)) return;

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  
  // Clean cubic bezier curves with horizontal control points (n8n-style!)
  const cpX1 = x1 + (x2 - x1) * 0.5;
  const cpY1 = y1;
  const cpX2 = x1 + (x2 - x1) * 0.5;
  const cpY2 = y2;
  
  ctx.bezierCurveTo(cpX1, cpY1, cpX2, cpY2, x2, y2);
};

const getPCBTracePoint = (x1: number, y1: number, x2: number, y2: number, progress: number) => {
  if (isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2)) {
    return { x: 0, y: 0 };
  }

  const t = progress;
  const mt = 1 - t;
  
  // Control points (matching drawPCBTrace)
  const cpX1 = x1 + (x2 - x1) * 0.5;
  const cpY1 = y1;
  const cpX2 = x1 + (x2 - x1) * 0.5;
  const cpY2 = y2;
  
  // Standard Cubic Bezier formula
  const x = mt * mt * mt * x1 + 3 * mt * mt * t * cpX1 + 3 * mt * t * t * cpX2 + t * t * t * x2;
  const y = mt * mt * mt * y1 + 3 * mt * mt * t * cpY1 + 3 * mt * t * t * cpY2 + t * t * t * y2;
  
  return { x, y };
};

export default function App() {
  const [data, setData] = useState<GraphData | null>(null);
  const [activeTab, setActiveTab] = useState<'verify' | 'ledger' | 'visualizer'>('verify');
  const [fileSortFilter, setFileSortFilter] = useState<'all' | 'stale' | 'intact'>('all');
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [impactedNodeIds, setImpactedNodeIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  
  // High-performance layout filters (Spacious Bubble Map)
  const [graphDensity, setGraphDensity] = useState<'files' | 'concepts' | 'all'>('files');
  const [expandedFileIds, setExpandedFileIds] = useState<Set<string>>(new Set());
  const [simulatedBrokenConceptIds, setSimulatedBrokenConceptIds] = useState<Set<string>>(new Set());

  // Bounded layout collapse states (ChatGPT styling alignment)
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isRightSidebarCollapsed, setIsRightSidebarCollapsed] = useState(false);
  const [isFocusMode, setIsFocusMode] = useState(false);

  // GitHub mock import states
  const [githubUrl, setGithubUrl] = useState('');
  const [importingState, setImportingState] = useState<'idle' | 'loading' | 'success' | 'failed'>('idle');
  const [importErrorMessage, setImportErrorMessage] = useState('');
  const [importSuccessMessage, setImportSuccessMessage] = useState('');

  // Handover selection helpers
  const [selectedDriftViolation, setSelectedDriftViolation] = useState<{
    conceptId: string;
    conceptLabel: string;
    filePath: string;
    sectionText: string;
    chainState: string;
    reason: string;
    governingADRLabel?: string;
    driftExplanation?: string;
  } | null>(null);

  const [selectedADR, setSelectedADR] = useState<{
    id: string;
    label: string;
    title: string;
    status: string;
    body: string;
  } | null>(null);
  
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasScrollWrapperRef = useRef<HTMLDivElement | null>(null);
  const nodesRef = useRef<GraphNode[]>([]);
  const edgesRef = useRef<GraphEdge[]>([]);
  const alphaRef = useRef<number>(1.0); 
  
  // Transform & Interaction states
  const [zoom, setZoom] = useState(1);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});

  const toggleFolder = (folderPath: string) => {
    setOpenFolders(prev => ({
      ...prev,
      [folderPath]: prev[folderPath] === false ? true : false
    }));
  };

  interface TreeNode {
    name: string;
    path: string;
    isFolder: boolean;
    file?: any;
    children: Record<string, TreeNode>;
    isFileBroken: boolean;
  }

  const isDraggingCanvas = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const draggedNode = useRef<GraphNode | null>(null);

  const centerScrollPosition = () => {
    const wrapper = canvasScrollWrapperRef.current;
    if (wrapper) {
      wrapper.scrollLeft = (1800 - wrapper.clientWidth) / 2;
      wrapper.scrollTop = (1200 - wrapper.clientHeight) / 2;
    }
  };

  const centerGraph = () => {
    setZoom(1);
    centerScrollPosition();
  };

  // Center scroll positioning when entering the tab or when sidebar size changes
  useEffect(() => {
    if (activeTab === 'visualizer') {
      setTimeout(centerScrollPosition, 100);
    }
  }, [activeTab, isSidebarCollapsed, isRightSidebarCollapsed]);

  // Global key listener for Ctrl+B Sidebar Toggle
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setIsSidebarCollapsed(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // ─── Load Graph Data ──────────────────────────────────────────────────────────

  const selectedADRRef = useRef<any>(null);
  useEffect(() => {
    selectedADRRef.current = selectedADR;
  }, [selectedADR]);

  const fetchGraph = async () => {
    try {
      const res = await fetch('/api/graph');
      const json = await res.json() as GraphData;
      setData(json);

      if (json.decisions && json.decisions.length > 0 && !selectedADRRef.current) {
        setSelectedADR(json.decisions[0]);
      }
    } catch (e) {
      console.error('Failed to fetch graph data:', e);
    }
  };

  useEffect(() => {
    fetchGraph();
    const timer = setInterval(fetchGraph, 3000);
    return () => clearInterval(timer);
  }, []);

  // Re-build physics graph when data, density, expanded files, or mutations change
  useEffect(() => {
    if (data) {
      buildPhysicsGraph(data, graphDensity);
    }
  }, [data, graphDensity, expandedFileIds, simulatedBrokenConceptIds]);

  // Recalculate blast radius if selection or mutations change
  useEffect(() => {
    if (selectedNode) {
      calculateBlastRadius(selectedNode);
    } else if (simulatedBrokenConceptIds.size > 0) {
      calculateGlobalSimulatedBlastRadius();
    } else {
      setImpactedNodeIds(new Set());
    }
  }, [selectedNode, simulatedBrokenConceptIds]);

  // Auto-select first drift violation if active
  useEffect(() => {
    if (data && activeTab === 'verify') {
      const driftItems = getDriftItems();
      if (driftItems.length > 0 && !selectedDriftViolation) {
        setSelectedDriftViolation(driftItems[0]);
      }
    }
  }, [data, activeTab]);

  // Wake up physics simulation and align nodes on Visualizer tab entry
  useEffect(() => {
    if (activeTab === 'visualizer') {
      const width = 1800;
      const height = 1200;
      
      nodesRef.current.forEach((node) => {
        if (node.x === 0 || isNaN(node.x) || node.x === width / 2) {
          node.x = width / 2 + (Math.random() - 0.5) * 450;
          node.y = height / 2 + (Math.random() - 0.5) * 450;
        }
      });
      
      alphaRef.current = 1.0; 
    }
  }, [activeTab]);

  // ─── Physics Graph Construction ────────────────────────────────────────────────

  const buildPhysicsGraph = (gData: GraphData, density: 'files' | 'concepts' | 'all') => {
    const nodesMap = new Map<string, GraphNode>();
    const newNodes: GraphNode[] = [];
    const newEdges: GraphEdge[] = [];

    const width = 1800;
    const height = 1200;

    // 1. Add File Nodes (Spacious Bubbles)
    gData.files.forEach((f) => {
      const node: GraphNode = {
        id: f.id,
        label: f.path.split(/[\\/]/).pop() || f.path,
        type: 'file',
        status: 'VALID',
        filePath: f.path,
        x: width / 2 + (Math.random() - 0.5) * 400,
        y: height / 2 + (Math.random() - 0.5) * 400,
        vx: 0,
        vy: 0,
        radius: 28, // spacious circular bubbles
      };
      
      const fileConcepts = gData.concepts.filter((c) => c.fileId === f.id);
      const fileDLs = gData.decisionLinks ? gData.decisionLinks.filter((l) => l.fileId === f.id) : [];
      const hasSemanticViolation = gData.semanticViolations ? gData.semanticViolations.some(v => v.fileAId === f.id || v.fileBId === f.id) : false;
      const isBroken = fileConcepts.some((c) => c.chainState === 'CHAIN_BROKEN' || simulatedBrokenConceptIds.has(c.id)) ||
                       fileDLs.some((l) => l.chainState === 'CHAIN_BROKEN') ||
                       hasSemanticViolation;
      const isDrift = fileConcepts.some((c) => c.chainState === 'ACKNOWLEDGED_DRIFT') ||
                      fileDLs.some((l) => l.chainState === 'ACKNOWLEDGED_DRIFT');
      node.status = isBroken ? 'CHAIN_BROKEN' : isDrift ? 'ACKNOWLEDGED_DRIFT' : 'VALID';

      nodesMap.set(f.id, node);
      newNodes.push(node);
    });

    const isFileExpanded = (fileId: string) => {
      return density === 'all' || density === 'concepts' || expandedFileIds.has(fileId);
    };

    const resolveVisibleNode = (id: string): GraphNode | undefined => {
      if (nodesMap.has(id)) return nodesMap.get(id);

      const section = gData.sections.find(s => s.id === id);
      if (section) {
        if (isFileExpanded(section.fileId)) {
          const concept = gData.concepts.find(c => c.sectionId === section.id);
          if (concept && nodesMap.has(concept.id) && density !== 'all') {
            return nodesMap.get(concept.id);
          }
          if (nodesMap.has(section.id)) return nodesMap.get(section.id);
        }
        return nodesMap.get(section.fileId);
      }

      const concept = gData.concepts.find(c => c.id === id);
      if (concept) {
        if (isFileExpanded(concept.fileId)) {
          if (nodesMap.has(concept.id)) return nodesMap.get(concept.id);
          const sectionNode = nodesMap.get(concept.sectionId);
          if (sectionNode) return sectionNode;
        }
        return nodesMap.get(concept.fileId);
      }

      return undefined;
    };

    // 2. Add Section Nodes (Sub-bubbles)
    gData.sections.forEach((s) => {
      const parentExpanded = isFileExpanded(s.fileId);
      if (density === 'all' || (parentExpanded && density !== 'concepts')) {
        const node: GraphNode = {
          id: s.id,
          label: `L${s.lineStart}-${s.lineEnd}`,
          type: 'section',
          status: 'VALID',
          filePath: s.filePath,
          rawText: s.rawText,
          lineRange: `${s.lineStart}-${s.lineEnd}`,
          x: width / 2 + (Math.random() - 0.5) * 450,
          y: height / 2 + (Math.random() - 0.5) * 450,
          vx: 0,
          vy: 0,
          radius: 12,
        };
        const sectionConcepts = gData.concepts.filter((c) => c.sectionId === s.id);
        const isBroken = sectionConcepts.some((c) => c.chainState === 'CHAIN_BROKEN' || simulatedBrokenConceptIds.has(c.id));
        const isDrift = sectionConcepts.some((c) => c.chainState === 'ACKNOWLEDGED_DRIFT');
        node.status = isBroken ? 'CHAIN_BROKEN' : isDrift ? 'ACKNOWLEDGED_DRIFT' : 'VALID';

        nodesMap.set(s.id, node);
        newNodes.push(node);

        const fileNode = nodesMap.get(s.fileId);
        if (fileNode) {
          newEdges.push({
            id: `${s.fileId}:${s.id}:CONTAINS`,
            from: fileNode,
            to: node,
            type: 'SYNTACTIC_CONTAINMENT',
            weight: 1.0,
            reason: 'File contains section',
          });
        }
      }
    });

    // 3. Add Concept Nodes (Circular bubbles)
    gData.concepts.forEach((c) => {
      const parentExpanded = isFileExpanded(c.fileId);
      if (density === 'concepts' || density === 'all' || parentExpanded) {
        const isSimulatedBroken = simulatedBrokenConceptIds.has(c.id);
        const node: GraphNode = {
          id: c.id,
          label: c.label,
          type: 'concept',
          status: isSimulatedBroken ? 'CHAIN_BROKEN' : c.chainState,
          filePath: c.canonical,
          chainLink: c.chainLink,
          x: width / 2 + (Math.random() - 0.5) * 480,
          y: height / 2 + (Math.random() - 0.5) * 480,
          vx: 0,
          vy: 0,
          radius: 8,
        };
        nodesMap.set(c.id, node);
        newNodes.push(node);

        const parentId = (density === 'all' && nodesMap.has(c.sectionId)) ? c.sectionId : c.fileId;
        const parentNode = nodesMap.get(parentId);
        if (parentNode) {
          newEdges.push({
            id: `${parentId}:${c.id}:ENCODES`,
            from: parentNode,
            to: node,
            type: 'SEMANTIC_ENCODING',
            weight: 0.8,
            reason: parentId === c.sectionId ? 'Section encodes concept' : 'File encodes concept',
          });
        }
      }
    });

    // 3.5. Add Decision Nodes (Amber hexagons styled as clean circular bubbles)
    if (gData.decisions) {
      gData.decisions.forEach((d) => {
        const associatedLinks = gData.decisionLinks?.filter(l => l.decisionId === d.id) || [];
        const isBroken = associatedLinks.some(l => l.chainState === 'CHAIN_BROKEN');
        const isDrift = associatedLinks.some(l => l.chainState === 'ACKNOWLEDGED_DRIFT');

        const node: GraphNode = {
          id: d.id,
          label: d.label,
          type: 'decision',
          status: isBroken ? 'CHAIN_BROKEN' : isDrift ? 'ACKNOWLEDGED_DRIFT' : 'VALID',
          filePath: '',
          x: width / 2 + (Math.random() - 0.5) * 500,
          y: height / 2 + (Math.random() - 0.5) * 500,
          vx: 0,
          vy: 0,
          radius: 18,
          decisionTitle: d.title,
          decisionStatus: d.status,
          decisionBody: d.body,
        };

        nodesMap.set(d.id, node);
        newNodes.push(node);

        associatedLinks.forEach((link) => {
          const targetNode = resolveVisibleNode(link.sectionId) || resolveVisibleNode(link.fileId);
          if (targetNode && targetNode.id !== node.id) {
            newEdges.push({
              id: `${node.id}:${targetNode.id}:DECISION_BIND`,
              from: node,
              to: targetNode,
              type: 'DECISION_BIND',
              weight: 1.2,
              reason: `Decision binds to ${targetNode.label}`,
            });
          }
        });
      });
    }

    // 4. Map Dependency Edges
    gData.edges.forEach((e) => {
      const fromNode = resolveVisibleNode(e.fromId);
      const toNode = resolveVisibleNode(e.toId);
      
      if (fromNode && toNode && fromNode.id !== toNode.id) {
        const edgeId = `${fromNode.id}:${toNode.id}:${e.edgeType}`;
        if (!newEdges.some(edge => edge.id === edgeId)) {
          newEdges.push({
            id: edgeId,
            from: fromNode,
            to: toNode,
            type: e.edgeType,
            weight: e.weight,
            reason: e.evidence.reason,
          });
        }
      }
    });

    // 4.5. Map Semantic Violations
    if (gData.semanticViolations) {
      gData.semanticViolations.forEach((v) => {
        const fromNode = resolveVisibleNode(v.sectionAId) || resolveVisibleNode(v.fileAId);
        const toNode = resolveVisibleNode(v.sectionBId) || resolveVisibleNode(v.fileBId);

        if (fromNode && toNode && fromNode.id !== toNode.id) {
          const edgeId = `${fromNode.id}:${toNode.id}:SEMANTIC_VIOLATION:${v.id}`;
          newEdges.push({
            id: edgeId,
            from: fromNode,
            to: toNode,
            type: 'SEMANTIC_VIOLATION',
            weight: 1.5,
            reason: v.reason,
          });
        }
      });
    }

    newNodes.forEach((node) => {
      const existing = nodesRef.current.find((n) => n.id === node.id);
      if (existing) {
        node.x = existing.x;
        node.y = existing.y;
        node.vx = existing.vx;
        node.vy = existing.vy;
      }
    });

    nodesRef.current = newNodes;
    edgesRef.current = newEdges;
  };

  // ─── Force-Directed Physics Simulation Engine ─────────────────────────────────

  useEffect(() => {
    let animId: number;

    const tick = () => {
      const nodes = nodesRef.current;
      const edges = edgesRef.current;
      if (nodes.length === 0) {
        animId = requestAnimationFrame(tick);
        return;
      }

      // Physics tick strictly runs ONLY when visualizer is open to protect canvas from collapsing
      if (activeTab === 'visualizer') {
        const currentAlpha = alphaRef.current;

        if (currentAlpha >= 0.005) {
          const gravity = 0.015; // low gravity for maximum spacing
          const charge = 450; // extremely strong charges to spread bubbles spacious
          const linkForce = 0.03;

          const safeWidth = 1800;
          const safeHeight = 1200;

          for (let i = 0; i < nodes.length; i++) {
            const n1 = nodes[i]!;
            for (let j = i + 1; j < nodes.length; j++) {
              const n2 = nodes[j]!;
              const dx = n2.x - n1.x;
              const dy = n2.y - n1.y;
              const distSq = dx * dx + dy * dy + 1.0; 
              
              if (distSq > 120000) continue; // massive spacer cutoff

              const dist = Math.sqrt(distSq);
              const force = (charge * (n1.radius + n2.radius)) / distSq;
              const fx = (dx / dist) * force * currentAlpha;
              const fy = (dy / dist) * force * currentAlpha;

              if (n1 !== draggedNode.current) {
                n1.vx -= fx;
                n1.vy -= fy;
              }
              if (n2 !== draggedNode.current) {
                n2.vx += fx;
                n2.vy += fy;
              }
            }
          }

          edges.forEach((edge) => {
            const dx = edge.to.x - edge.from.x;
            const dy = edge.to.y - edge.from.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1.0;
            // High spacers target distance for visual bubble maps
            const targetDist = edge.type.startsWith('SYNTACTIC_CONTAINMENT') ? 110 : 220;
            const force = (dist - targetDist) * linkForce * edge.weight * currentAlpha;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;

            if (edge.from !== draggedNode.current) {
              edge.from.vx += fx;
              edge.from.vy += fy;
            }
            if (edge.to !== draggedNode.current) {
              edge.to.vx -= fx;
              edge.to.vy -= fy;
            }
          });

          nodes.forEach((n) => {
            if (n === draggedNode.current) return;

            n.vx += (safeWidth / 2 - n.x) * gravity * currentAlpha;
            n.vy += (safeHeight / 2 - n.y) * gravity * currentAlpha;

            n.vx *= 0.72;
            n.vy *= 0.72;

            n.x += n.vx;
            n.y += n.vy;
          });

          alphaRef.current *= 0.97;
        }

        draw();
      }

      animId = requestAnimationFrame(tick);
    };

    tick();
    return () => cancelAnimationFrame(animId);
  }, [activeTab, selectedNode, impactedNodeIds, simulatedBrokenConceptIds]);

  const updateCursor = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (draggedNode.current || isDraggingCanvas.current) {
      canvas.style.cursor = 'grabbing';
    } else if (hoveredNode) {
      canvas.style.cursor = 'grab';
    } else {
      canvas.style.cursor = 'default';
    }
  };

  // ─── Center View on Target Node (STABLE COORDINATES, NO PHYSICS RESET!) ───

  const focusOnNode = (node: GraphNode) => {
    setSelectedNode(node);
    calculateBlastRadius(node);
  };

  // Dynamic layout alignment: re-centers viewport smoothly via physics when sidebars collapse or expand
  useEffect(() => {
    if (activeTab === 'visualizer') {
      alphaRef.current = 0.65; // wake up physics to re-center nodes in the new viewport dimensions
    }
  }, [isSidebarCollapsed, isRightSidebarCollapsed, activeTab]);

  const toggleFileExpansion = (fileId: string) => {
    setExpandedFileIds((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) {
        next.delete(fileId);
      } else {
        next.add(fileId);
      }
      return next;
    });
    // Stabilized gentle physics shift, avoiding coordinate explosion
    alphaRef.current = 0.50;
  };

  // ─── Blast Radius Traversal calculations ─────────────────────────────────────

  const calculateBlastRadius = (node: GraphNode) => {
    const visited = new Set<string>();
    const queue: string[] = [node.id];
    visited.add(node.id);

    simulatedBrokenConceptIds.forEach(id => {
      if (!visited.has(id)) {
        visited.add(id);
        queue.push(id);
      }
    });

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      edgesRef.current.forEach((edge) => {
        if (edge.from.id === currentId && !visited.has(edge.to.id)) {
          if (edge.type !== 'SYNTACTIC_CONTAINMENT') {
            visited.add(edge.to.id);
            queue.push(edge.to.id);
          }
        }
      });
    }

    setImpactedNodeIds(visited);
  };

  const calculateGlobalSimulatedBlastRadius = () => {
    const visited = new Set<string>();
    const queue: string[] = [];

    simulatedBrokenConceptIds.forEach(id => {
      visited.add(id);
      queue.push(id);
    });

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      edgesRef.current.forEach((edge) => {
        if (edge.from.id === currentId && !visited.has(edge.to.id)) {
          if (edge.type !== 'SYNTACTIC_CONTAINMENT') {
            visited.add(edge.to.id);
            queue.push(edge.to.id);
          }
        }
      });
    }

    setImpactedNodeIds(visited);
  };

  // ─── Simulation Sandbox Helpers ────────────────────────────────────────────────

  const toggleSimulateBrokenConcept = (conceptId: string) => {
    setSimulatedBrokenConceptIds((prev) => {
      const next = new Set(prev);
      if (next.has(conceptId)) {
        next.delete(conceptId);
      } else {
        next.add(conceptId);
      }
      return next;
    });
    alphaRef.current = 0.35;
  };

  const clearAllSimulatedMutations = () => {
    setSimulatedBrokenConceptIds(new Set());
    alphaRef.current = 0.35;
  };

  // ─── Simulated GitHub Importer Flow ──────────────────────────────────────────

  const handleGitHubImport = () => {
    setImportErrorMessage('');
    setImportSuccessMessage('');
    
    const cleanUrl = githubUrl.trim();
    if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
      setImportingState('failed');
      setImportErrorMessage('Import Failed: Invalid repository URL. URL must start with http:// or https://');
      return;
    }
    
    if (!cleanUrl.includes('github.com/')) {
      setImportingState('failed');
      setImportErrorMessage('Import Failed: Invalid GitHub repository path. Please match format github.com/user/repo');
      return;
    }

    setImportingState('loading');
    setTimeout(() => {
      setImportingState('success');
      setImportSuccessMessage(`Successfully synchronized ${cleanUrl.replace(/^https?:\/\/(www\.)?github\.com\//, '')}. Loaded node network.`);
      
      if (data) {
        const mockRepoName = cleanUrl.split('/').pop() || 'imported-project';
        const mockFileId = `file:github:${Date.now()}`;
        const mockConceptId = `concept:github:${Date.now()}`;
        
        const mockFile: FileNode = {
          id: mockFileId,
          path: `github/${mockRepoName}/main.go`,
          kind: 'source',
          contentHash: 'mock_sha256_import_hash',
          sectionCount: 1,
        };

        const mockConcept: ConceptNode = {
          id: mockConceptId,
          label: 'GitHubImportValidation',
          canonical: `github/${mockRepoName}/main.go`,
          sectionId: `section:github:${Date.now()}`,
          fileId: mockFileId,
          confidence: '0.98',
          chainLink: 'merkle_link_validation_imported_ok',
          chainState: 'VALID',
          brokenAt: null,
        };

        const mockEdge: EdgeLink = {
          id: `edge:github:${Date.now()}`,
          fromId: mockFileId,
          toId: mockConceptId,
          edgeType: 'SEMANTIC_ENCODING',
          weight: 0.9,
          evidence: {
            reason: 'GitHub simulated node import connectivity validation',
            sourceAnalysis: 'Static analysis parse'
          }
        };

        const updatedData: GraphData = {
          ...data,
          files: [...data.files, mockFile],
          concepts: [...data.concepts, mockConcept],
          edges: [...data.edges, mockEdge],
          health: {
            ...data.health,
            totalFiles: data.health.totalFiles + 1,
            totalConcepts: data.health.totalConcepts + 1,
          }
        };

        setData(updatedData);
      }
    }, 1200);
  };

  // ─── Verification & Drift Calculation Helpers ────────────────────────────────

  const getDriftItems = () => {
    if (!data) return [];

    // 1. Concept-level drift
    const activeDriftItems = data.concepts.map(concept => {
      const isSimulatedBroken = simulatedBrokenConceptIds.has(concept.id);
      const isBroken = concept.chainState === 'CHAIN_BROKEN' || isSimulatedBroken;
      const isDrift = concept.chainState === 'ACKNOWLEDGED_DRIFT';
      if (!isBroken && !isDrift) return null;

      const file = data.files.find(f => f.id === concept.fileId);
      const section = data.sections.find(s => s.id === concept.sectionId);
      const link = data.decisionLinks?.find(l => l.sectionId === concept.sectionId);
      const adr = link && data.decisions?.find(d => d.id === link.decisionId);

      return {
        conceptId: concept.id,
        conceptLabel: concept.label,
        filePath: file ? file.path.split(/[\\/]/).pop() || file.path : 'unknown',
        sectionText: section ? section.rawText : '(missing context)',
        chainState: isBroken ? 'DRIFT' : 'ACKNOWLEDGED',
        reason: isBroken
          ? `Merkle cryptographic chain mismatch on concept "${concept.label}"`
          : `Drift acknowledged on concept "${concept.label}"`,
        governingADRLabel: adr ? adr.label : undefined,
        driftExplanation: undefined as string | undefined,
      };
    }).filter(Boolean) as Array<{
      conceptId: string; conceptLabel: string; filePath: string;
      sectionText: string; chainState: string; reason: string;
      governingADRLabel?: string; driftExplanation?: string;
    }>;

    // 2. Decision link (ADR-to-code binding) drift — THE KEY VIOLATIONS
    const brokenDLItems = (data.decisionLinks || [])
      .filter(dl => dl.chainState === 'CHAIN_BROKEN' || dl.chainState === 'ACKNOWLEDGED_DRIFT')
      .map(dl => {
        const decision = data.decisions?.find(d => d.id === dl.decisionId);
        const file = data.files.find(f => f.id === dl.fileId);
        const section = data.sections.find(s => s.id === dl.sectionId);
        const fileLabel = file ? file.path.split(/[\\/]/).pop() || file.path : 'unknown';
        // Skip if already shown via concept-level drift for same decision+file
        const alreadyListed = activeDriftItems.some(
          item => item.governingADRLabel === decision?.label && item.filePath === fileLabel
        );
        if (alreadyListed) return null;
        return {
          conceptId: `dl:${dl.decisionId}:${dl.sectionId}`,
          conceptLabel: decision ? decision.label : dl.decisionId,
          filePath: fileLabel,
          sectionText: section ? section.rawText : '(code section)',
          chainState: dl.chainState === 'CHAIN_BROKEN' ? 'DRIFT' : 'ACKNOWLEDGED',
          reason: dl.chainState === 'CHAIN_BROKEN'
            ? `ADR "${decision?.label || dl.decisionId}" cryptographic bridge broken — code no longer matches documented rationale`
            : `Drift acknowledged on ADR "${decision?.label || dl.decisionId}"`,
          governingADRLabel: decision ? decision.label : undefined,
          driftExplanation: dl.driftExplanation,
        };
      }).filter(Boolean) as Array<{
        conceptId: string; conceptLabel: string; filePath: string;
        sectionText: string; chainState: string; reason: string;
        governingADRLabel?: string; driftExplanation?: string;
        isSemanticViolation?: boolean; proposedFix?: string;
      }>;

    // 3. Agentic Semantic Violations
    const semanticViolationItems = (data.semanticViolations || [])
      .map(v => ({
        conceptId: `sv:${v.id}`,
        conceptLabel: v.conceptLabel,
        filePath: `${v.fileAPath.split(/[\\/]/).pop()} ↔ ${v.fileBPath.split(/[\\/]/).pop()}`,
        sectionText: `Conflict Reason:\n${v.reason}\n\nProposed Fix:\n${v.proposedFix}`,
        chainState: 'DRIFT',
        reason: `Agent Brain logic contradiction: ${v.reason}`,
        governingADRLabel: undefined,
        driftExplanation: v.reason,
        isSemanticViolation: true,
        proposedFix: v.proposedFix,
      }));

    return [...activeDriftItems, ...brokenDLItems, ...semanticViolationItems];
  };

  // ─── Code Violation Highlighter ──────────────────────────────────────────────

  const highlightCodeViolation = (codeText: string, conceptLabel: string) => {
    if (!codeText) return null;
    const lines = codeText.split('\n');
    return (
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', lineHeight: '1.6', color: '#a1a1aa' }}>
        {lines.map((line, idx) => {
          const lowerLine = line.toLowerCase();
          const lowerConcept = conceptLabel.toLowerCase();
          const isViolation = lowerLine.includes(lowerConcept);
          if (isViolation) {
            return (
              <div 
                key={idx} 
                style={{ 
                  borderLeft: '3px solid #ef4444', 
                  backgroundColor: 'rgba(239, 68, 68, 0.12)', 
                  padding: '2px 8px', 
                  margin: '2px 0',
                  borderRadius: '0 4px 4px 0',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  boxShadow: 'inset 0 0 4px rgba(239, 68, 68, 0.2)'
                }}
              >
                <span style={{ whiteSpace: 'pre', color: '#f4f4f5' }}>{line}</span>
                <span 
                  style={{ 
                    fontSize: '8px', 
                    color: '#ef4444', 
                    backgroundColor: 'rgba(239, 68, 68, 0.2)', 
                    border: '1px solid rgba(239, 68, 68, 0.4)', 
                    padding: '1px 4px', 
                    borderRadius: '3px',
                    fontWeight: 'bold',
                    marginLeft: '8px',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    flexShrink: 0
                  }}
                >
                  [VIOLATION]
                </span>
              </div>
            );
          }
          return (
            <div key={idx} style={{ padding: '0 8px', whiteSpace: 'pre' }}>
              {line}
            </div>
          );
        })}
      </div>
    );
  };

  // ─── Drawing Loop (FLAT MONOCHROMATIC BUBBLE MAP) ──────────────────────────

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (canvas.clientWidth === 0 || canvas.clientHeight === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const canvasWidth = 1800;
    const canvasHeight = 1200;

    if (canvas.width !== canvasWidth * dpr || canvas.height !== canvasHeight * dpr) {
      canvas.width = canvasWidth * dpr;
      canvas.height = canvasHeight * dpr;
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    // Zoom centered at (900, 600)
    ctx.translate(900, 600);
    ctx.scale(zoom, zoom);
    ctx.translate(-900, -600);

    const nodes = nodesRef.current;
    const edges = edgesRef.current;

    // 1. Monochromatic Figma-style grid layout (resembling ChatGPT black grid)
    const gridSize = 45;
    ctx.fillStyle = '#0f0f11'; 
    for (let x = 0; x <= 1800; x += gridSize) {
      for (let y = 0; y <= 1200; y += gridSize) {
        ctx.fillRect(x - 1, y - 1, 2, 2);
      }
    }

    const isConceptSelected = selectedNode && selectedNode.type === 'concept';
    const isBrokenPathMode = isConceptSelected && (selectedNode.status === 'CHAIN_BROKEN' || simulatedBrokenConceptIds.has(selectedNode.id));

    // 2. Draw Edges (Flat, simple dev-genic connected lines)
    edges.forEach((edge) => {
      const isFromActive = impactedNodeIds.has(edge.from.id);
      const isToActive = impactedNodeIds.has(edge.to.id);
      const isFromSelected = selectedNode && selectedNode.id === edge.from.id;
      const isToSelected = selectedNode && selectedNode.id === edge.to.id;

      const isBlastPath = isFromActive && isToActive && edge.type !== 'SYNTACTIC_CONTAINMENT';
      const isActiveTrace = isBlastPath || isFromSelected || isToSelected;
      
      const isBrokenEdge = edge.to.status === 'CHAIN_BROKEN' || edge.from.status === 'CHAIN_BROKEN';
      const isDriftEdge = edge.to.status === 'ACKNOWLEDGED_DRIFT' || edge.from.status === 'ACKNOWLEDGED_DRIFT';

      ctx.save();
      if (isBrokenPathMode) {
        const edgeBelongsToPath = impactedNodeIds.has(edge.from.id) && impactedNodeIds.has(edge.to.id);
        ctx.globalAlpha = edgeBelongsToPath ? 1.0 : 0.12;
      } else {
        ctx.globalAlpha = 1.0;
      }

      if (isActiveTrace) {
        ctx.save();
        ctx.strokeStyle = isBrokenEdge ? '#ef4444' : isDriftEdge ? '#f59e0b' : '#d4d4d8';
        ctx.lineWidth = isBrokenEdge ? 1.8 : 1.2;
        ctx.globalAlpha = isBrokenEdge ? 1.0 : isDriftEdge ? 0.8 : 0.45;
        if (isBrokenEdge) {
          ctx.setLineDash([4, 4]);
        }
        drawPCBTrace(ctx, edge.from.x, edge.from.y, edge.to.x, edge.to.y);
        ctx.stroke();
        ctx.restore();
        
        // Render flowing warning particle ONLY for active desync traces
        if (isBrokenEdge || isDriftEdge) {
          const time = Date.now() / 800; 
          const progress = time % 1.0;
          const pt = getPCBTracePoint(edge.from.x, edge.from.y, edge.to.x, edge.to.y, progress);
          
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2);
          ctx.fillStyle = isBrokenEdge ? '#ef4444' : '#f59e0b';
          ctx.fill();
        }
      } else if (edge.type.startsWith('SYNTACTIC_CONTAINMENT')) {
        ctx.save();
        ctx.strokeStyle = '#27272a'; 
        ctx.lineWidth = 1.0;
        ctx.setLineDash([2, 4]);
        drawPCBTrace(ctx, edge.from.x, edge.from.y, edge.to.x, edge.to.y);
        ctx.stroke();
        ctx.restore();
      } else if (edge.type.startsWith('SEMANTIC_VIOLATION')) {
        ctx.save();
        ctx.strokeStyle = '#f97316'; // Glowing vibrant orange for semantic contradictions
        ctx.lineWidth = 2.0;
        ctx.setLineDash([4, 3]);
        drawPCBTrace(ctx, edge.from.x, edge.from.y, edge.to.x, edge.to.y);
        ctx.stroke();
        ctx.restore();

        // Flowing warning particle for semantic contradictions
        const time = Date.now() / 600; 
        const progress = time % 1.0;
        const pt = getPCBTracePoint(edge.from.x, edge.from.y, edge.to.x, edge.to.y, progress);
        
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = '#f97316';
        ctx.fill();
      } else if (edge.type === 'DECISION_BIND') {
        const isBrokenEdge = edge.to.status === 'CHAIN_BROKEN' || edge.from.status === 'CHAIN_BROKEN';
        const isDriftEdge = edge.to.status === 'ACKNOWLEDGED_DRIFT' || edge.from.status === 'ACKNOWLEDGED_DRIFT';
        ctx.save();
        ctx.strokeStyle = isBrokenEdge ? '#ef4444' : isDriftEdge ? '#f59e0b' : '#f59e0b';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 3]);
        drawPCBTrace(ctx, edge.from.x, edge.from.y, edge.to.x, edge.to.y);
        ctx.stroke();
        ctx.restore();
      } else {
        ctx.save();
        ctx.strokeStyle = '#1e1e24'; // subtle thin dark grey lines
        ctx.lineWidth = 1.0;
        drawPCBTrace(ctx, edge.from.x, edge.from.y, edge.to.x, edge.to.y);
        ctx.stroke();
        ctx.restore();
      }
      ctx.restore();
    });

    // 3. Draw Nodes (Spacious clean circular interconnected bubbles)
    nodes.forEach((node) => {
      if (isNaN(node.x) || isNaN(node.y)) return;
      const isSelected = selectedNode?.id === node.id;
      const isHovered = hoveredNode?.id === node.id;
      const isImpacted = impactedNodeIds.has(node.id);

      const displayStatus = (simulatedBrokenConceptIds.has(node.id) || node.status === 'CHAIN_BROKEN') 
        ? 'CHAIN_BROKEN' 
        : node.status;

      ctx.save();
      if (isBrokenPathMode) {
        const nodeBelongsToPath = node.id === selectedNode.id || impactedNodeIds.has(node.id);
        ctx.globalAlpha = nodeBelongsToPath ? 1.0 : 0.12;
      } else {
        ctx.globalAlpha = 1.0;
      }

      // File Nodes: Clean circular spacious bubbles with extension text inside
      if (node.type === 'file') {
        const r = 26; 
        let statusColor = '#27272a'; 
        let labelColor = '#a1a1aa';
        
        const isFileBroken = displayStatus === 'CHAIN_BROKEN';
        const isFileDrift = displayStatus === 'ACKNOWLEDGED_DRIFT' || (isImpacted && selectedNode?.id !== node.id);

        if (isFileBroken) {
          statusColor = '#ef4444';
          labelColor = '#ef4444';
        } else if (isFileDrift) {
          statusColor = '#f59e0b';
          labelColor = '#f59e0b';
        } else if (isSelected) {
          statusColor = '#fafafa';
          labelColor = '#fafafa';
        }

        ctx.save();
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx.fillStyle = '#0f0f11'; 
        ctx.fill();
        ctx.strokeStyle = statusColor;
        ctx.lineWidth = isSelected ? 2.5 : 1.5;
        ctx.stroke();
        ctx.restore();

        const ext = node.filePath.split('.').pop()?.toUpperCase() || 'SRC';
        ctx.font = 'bold 9px var(--font-mono)';
        ctx.fillStyle = isSelected ? '#fafafa' : '#71717a';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(ext, node.x, node.y);

        ctx.font = isSelected ? '600 11px Inter' : '500 10px Inter';
        ctx.fillStyle = isFileBroken ? '#ef4444' : isSelected ? '#fafafa' : '#d4d4d8';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(node.label, node.x, node.y + r + 6);
      }
      
      // Section Nodes: Smaller clean circular bubbles
      else if (node.type === 'section') {
        const r = 10;
        let statusColor = '#27272a'; 
        if (displayStatus === 'CHAIN_BROKEN') statusColor = '#ef4444';
        else if (displayStatus === 'ACKNOWLEDGED_DRIFT') statusColor = '#f59e0b';
        else if (isSelected) statusColor = '#fafafa';

        ctx.save();
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx.fillStyle = '#0f0f11';
        ctx.fill();
        ctx.strokeStyle = statusColor;
        ctx.lineWidth = isSelected ? 2.0 : 1.2;
        ctx.stroke();
        ctx.restore();

        if (isSelected || isHovered) {
          ctx.font = '9px var(--font-mono)';
          ctx.fillStyle = '#fafafa';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillText(node.label, node.x, node.y - r - 4);
        }
      }

      // Concept Nodes: Concentric copper vias without sci-fi glows
      else if (node.type === 'concept') {
        let statusColor = '#27272a'; 
        let coreColor = '#71717a'; 
        
        const isBroken = displayStatus === 'CHAIN_BROKEN';
        const isDrift = displayStatus === 'ACKNOWLEDGED_DRIFT' || (isImpacted && selectedNode?.id !== node.id);

        if (isBroken) {
          statusColor = '#ef4444';
          coreColor = '#ef4444';
        } else if (isDrift) {
          statusColor = '#f59e0b';
          coreColor = '#f59e0b';
        } else if (isSelected) {
          statusColor = '#fafafa';
          coreColor = '#fafafa';
        }

        ctx.save();
        ctx.beginPath();
        ctx.arc(node.x, node.y, 8, 0, Math.PI * 2); 
        ctx.fillStyle = '#000000';
        ctx.fill();
        ctx.strokeStyle = statusColor;
        ctx.lineWidth = isSelected ? 2.2 : 1.2;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(node.x, node.y, 3.0, 0, Math.PI * 2);
        ctx.fillStyle = coreColor;
        ctx.fill();
        ctx.restore();

        if (isSelected || isHovered || isBroken) {
          ctx.font = '10px Inter';
          ctx.fillStyle = isBroken ? '#ef4444' : isSelected ? '#fafafa' : '#d4d4d8';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(node.label, node.x, node.y + 11);
        }
      }

      // Decision Nodes: Spacious circular amber bubbles (Notion/ChatGPT style)
      else if (node.type === 'decision') {
        const r = 16;
        let statusColor = '#f59e0b'; 
        const isBroken = displayStatus === 'CHAIN_BROKEN';
        const isDrift = displayStatus === 'ACKNOWLEDGED_DRIFT';

        if (isBroken) {
          statusColor = '#ef4444';
        } else if (isDrift) {
          statusColor = '#f59e0b';
        } else if (isSelected) {
          statusColor = '#fafafa';
        }

        ctx.save();
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx.fillStyle = '#0f0f11'; 
        ctx.fill();
        ctx.strokeStyle = statusColor;
        ctx.lineWidth = isSelected ? 2.5 : 1.5;
        ctx.stroke();
        ctx.restore();

        ctx.font = 'bold 8px var(--font-mono)';
        ctx.fillStyle = isSelected ? '#fafafa' : '#eab308';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('ADR', node.x, node.y);

        if (isSelected || isHovered || isBroken) {
          ctx.font = '10px Inter';
          ctx.fillStyle = isBroken ? '#ef4444' : '#f59e0b';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(node.label, node.x, node.y + r + 5);
        }
      }

      if (isSelected && node.type !== 'file') {
        ctx.save();
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius + 6, 0, Math.PI * 2);
        ctx.strokeStyle = displayStatus === 'CHAIN_BROKEN' ? '#ef4444' : '#fafafa';
        ctx.lineWidth = 1.0;
        ctx.setLineDash([2, 4]);
        ctx.stroke();
        ctx.restore();
      }
      ctx.restore();
    });

    ctx.restore();
  };

  // ─── Mouse event handlers ──────────────────────────────────────────────────

  const getCanvasMousePos = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    alphaRef.current = 0.45;
    const pos = getCanvasMousePos(e);
    const localX = 900 + (pos.x - 900) / zoom;
    const localY = 600 + (pos.y - 600) / zoom;
    const nodes = nodesRef.current;

    let foundNode: GraphNode | null = null;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i]!;
      const dx = localX - node.x;
      const dy = localY - node.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      const clickTolerance = node.type === 'file' ? 24 : node.radius + 6;
      if (dist < clickTolerance) {
        foundNode = node;
        break;
      }
    }

    if (foundNode) {
      setSelectedNode(foundNode);
      calculateBlastRadius(foundNode);
    } else {
      setSelectedNode(null);
      setImpactedNodeIds(new Set());
    }

    updateCursor();
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const pos = getCanvasMousePos(e);
    const localX = 900 + (pos.x - 900) / zoom;
    const localY = 600 + (pos.y - 600) / zoom;
    const nodes = nodesRef.current;
    let foundHover: GraphNode | null = null;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i]!;
      const dx = localX - node.x;
      const dy = localY - node.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const tolerance = node.type === 'file' ? 24 : node.radius + 6;
      if (dist < tolerance) {
        foundHover = node;
        break;
      }
    }
    setHoveredNode(foundHover);
    updateCursor();
  };

  const handleMouseUp = () => {
    updateCursor();
  };

  const handleDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const pos = getCanvasMousePos(e);
    const localX = 900 + (pos.x - 900) / zoom;
    const localY = 600 + (pos.y - 600) / zoom;
    const nodes = nodesRef.current;

    let foundNode: GraphNode | null = null;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i]!;
      const dx = localX - node.x;
      const dy = localY - node.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const clickTolerance = node.type === 'file' ? 24 : node.radius + 6;
      
      if (dist < clickTolerance) {
        foundNode = node;
        break;
      }
    }

    if (foundNode && foundNode.type === 'file') {
      toggleFileExpansion(foundNode.id);
    }
  };

  // ─── Filter & Search Helpers ──────────────────────────────────────────────────

  const filteredFiles = data?.files.filter((f) =>
    f.path.toLowerCase().includes(searchQuery.toLowerCase())
  ) || [];

  const getHealthPercent = () => {
    if (!data?.health) return 100;
    const mutatedCount = simulatedBrokenConceptIds.size;
    const brokenCount = data.health.brokenChains;
    const total = data.health.totalConcepts || 1;
    return Math.max(0, Math.round(((total - (brokenCount + mutatedCount)) / total) * 100));
  };

  const isDriftBlocked = () => {
    if (!data?.health) return false;
    return data.health.brokenChains > 0 || simulatedBrokenConceptIds.size > 0;
  };

  const parseMarkdownInline = (text: string) => {
    const parts = text.split(/\*\*([\s\S]*?)\*\*/g);
    return parts.map((part, i) => {
      if (i % 2 === 1) {
        return <strong key={i} style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{part}</strong>;
      }
      return part;
    });
  };

  // Clean document text rendering helper
  const renderADRText = (body: string) => {
    return body.split('\n').map((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('# ')) {
        return null;
      } else if (trimmed.startsWith('## ')) {
        return <h2 key={index}>{parseMarkdownInline(trimmed.replace('## ', ''))}</h2>;
      } else if (trimmed.startsWith('1. ') || trimmed.startsWith('2. ') || trimmed.startsWith('3. ')) {
        return <li key={index} style={{ marginLeft: '12px' }}>{parseMarkdownInline(trimmed.replace(/^\d+\.\s+/, ''))}</li>;
      } else if (trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
        return <li key={index}>{parseMarkdownInline(trimmed.replace(/^[\*\-]\s+/, ''))}</li>;
      } else if (trimmed.startsWith('> ')) {
        return <blockquote key={index}>{parseMarkdownInline(trimmed.replace('> ', ''))}</blockquote>;
      } else if (trimmed.length === 0) {
        return <div key={index} style={{ height: '8px' }} />;
      } else {
        return <p key={index}>{parseMarkdownInline(line)}</p>;
      }
    });
  };

  return (
    <div className="app-container">
      {/* ─── Minimalist Left Sidebar (ChatGPT layout alignment) ─── */}
      <div className={`sidebar ${isSidebarCollapsed ? 'collapsed' : ''}`} style={{ backgroundColor: '#09090b', borderRight: '1px solid #1f1f23' }}>
        <div className="sidebar-header" style={{ borderBottom: '1px solid #1f1f23' }}>
          <div className="sidebar-brand" style={{ letterSpacing: '0.15em', fontWeight: 600 }}>REPONOESIS</div>
          <button 
            onClick={() => setIsSidebarCollapsed(true)}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#8e8e93',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              padding: '4px',
              borderRadius: '4px',
            }}
            title="Collapse Sidebar (Ctrl+B)"
            className="btn-sidebar-toggle"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
          </button>
        </div>

        {/* Sidebar Navigation */}
        <div className="sidebar-nav" style={{ borderBottom: '1px solid #1f1f23' }}>
          <button 
            className={`sidebar-nav-item ${activeTab === 'verify' ? 'active' : ''}`}
            onClick={() => setActiveTab('verify')}
            style={{ borderRadius: '8px', padding: '10px 12px' }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.8 }}><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="m9 12 2 2 4-4"/></svg>
            Handover
          </button>
          
          <button 
            className={`sidebar-nav-item ${activeTab === 'visualizer' ? 'active' : ''}`}
            onClick={() => setActiveTab('visualizer')}
            style={{ borderRadius: '8px', padding: '10px 12px' }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.8 }}><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
            Circuit Visualizer
          </button>

          <button 
            className={`sidebar-nav-item ${activeTab === 'ledger' ? 'active' : ''}`}
            onClick={() => setActiveTab('ledger')}
            style={{ borderRadius: '8px', padding: '10px 12px' }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.8 }}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            Rationale Ledger
          </button>
        </div>

        {/* Workspace Files Explorer List */}
        <div className="sidebar-files-section">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <div className="sidebar-section-title" style={{ fontSize: '9px', color: '#56565a', margin: 0, padding: 0 }}>Workspace Files</div>
          </div>
          
          {/* Sorting / Filter tabs */}
          <div style={{ display: 'flex', gap: '4px', marginBottom: '10px' }}>
            <button 
              onClick={() => setFileSortFilter('all')} 
              style={{
                flex: 1,
                background: fileSortFilter === 'all' ? 'var(--bg-hover)' : 'transparent',
                border: '1px solid #1f1f23',
                color: fileSortFilter === 'all' ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontSize: '9px',
                padding: '4px 0',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: fileSortFilter === 'all' ? 600 : 400,
                transition: 'all 0.15s ease'
              }}
            >
              All
            </button>
            <button 
              onClick={() => setFileSortFilter('stale')} 
              style={{
                flex: 1,
                background: fileSortFilter === 'stale' ? 'rgba(239, 68, 68, 0.1)' : 'transparent',
                border: fileSortFilter === 'stale' ? '1px solid var(--status-broken)' : '1px solid #1f1f23',
                color: fileSortFilter === 'stale' ? 'var(--status-broken)' : 'var(--text-secondary)',
                fontSize: '9px',
                padding: '4px 0',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: fileSortFilter === 'stale' ? 600 : 400,
                transition: 'all 0.15s ease'
              }}
            >
              Stale
            </button>
            <button 
              onClick={() => setFileSortFilter('intact')} 
              style={{
                flex: 1,
                background: fileSortFilter === 'intact' ? 'rgba(16, 185, 129, 0.1)' : 'transparent',
                border: fileSortFilter === 'intact' ? '1px solid var(--status-valid)' : '1px solid #1f1f23',
                color: fileSortFilter === 'intact' ? 'var(--status-valid)' : 'var(--text-secondary)',
                fontSize: '9px',
                padding: '4px 0',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: fileSortFilter === 'intact' ? 600 : 400,
                transition: 'all 0.15s ease'
              }}
            >
              Intact
            </button>
          </div>

          <div className="sidebar-file-list" style={{ maxHeight: 'calc(100vh - 310px)', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {(() => {
              if (!data?.files) return null;

              // 1. Map files to get relative paths and isFileBroken status (including semantic violations)
              const mapped = data.files.map(file => {
                const fileConcepts = data.concepts.filter((c) => c.fileId === file.id) || [];
                const fileDLs = data.decisionLinks ? data.decisionLinks.filter((l) => l.fileId === file.id) : [];
                const hasContradiction = data.semanticViolations ? data.semanticViolations.some(v => v.fileAId === file.id || v.fileBId === file.id) : false;
                const isFileBroken = fileConcepts.some((c) => c.chainState === 'CHAIN_BROKEN' || simulatedBrokenConceptIds.has(c.id)) ||
                                     fileDLs.some((l) => l.chainState === 'CHAIN_BROKEN') ||
                                     hasContradiction;
                return { file, isFileBroken, path: file.path.replace(/\\/g, '/') };
              });

              // 2. Compute longest common prefix (project root) to make relative paths
              const paths = mapped.map(m => m.path);
              let commonPrefix = '';
              if (paths.length > 0) {
                const sorted = [...paths].sort();
                const first = sorted[0]!;
                const last = sorted[sorted.length - 1]!;
                let i = 0;
                while (i < first.length && first[i] === last[i]) {
                  i++;
                }
                commonPrefix = first.substring(0, i);
                const lastSlash = commonPrefix.lastIndexOf('/');
                commonPrefix = lastSlash !== -1 ? commonPrefix.substring(0, lastSlash + 1) : '';
              }

              const relativeMapped = mapped.map(m => {
                const relPath = m.path.startsWith(commonPrefix) ? m.path.substring(commonPrefix.length) : m.path;
                return {
                  file: m.file,
                  relPath,
                  isFileBroken: m.isFileBroken
                };
              });

              // 3. Filter mapped files based on sort-filter
              const filtered = relativeMapped.filter(item => {
                if (fileSortFilter === 'stale') return item.isFileBroken;
                if (fileSortFilter === 'intact') return !item.isFileBroken;
                return true;
              });

              // 4. Build hierarchical tree structure
              const root: TreeNode = {
                name: 'root',
                path: '',
                isFolder: true,
                children: {},
                isFileBroken: false
              };

              for (const item of filtered) {
                const parts = item.relPath.split('/');
                let current = root;

                if (item.isFileBroken) {
                  current.isFileBroken = true;
                }

                let currentPath = '';
                for (let i = 0; i < parts.length; i++) {
                  const part = parts[i]!;
                  if (!part) continue;

                  currentPath = currentPath ? `${currentPath}/${part}` : part;
                  const isLast = i === parts.length - 1;

                  if (!current.children[part]) {
                    current.children[part] = {
                      name: part,
                      path: currentPath,
                      isFolder: !isLast,
                      children: {},
                      isFileBroken: item.isFileBroken,
                      file: isLast ? item.file : undefined
                    };
                  } else {
                    if (item.isFileBroken) {
                      current.children[part]!.isFileBroken = true;
                    }
                  }

                  current = current.children[part]!;
                }
              }

              // 5. Recursive tree node renderer
              const renderTree = (node: TreeNode, depth = 0): React.ReactNode => {
                const sortedChildren = Object.values(node.children).sort((a, b) => {
                  if (a.isFolder && !b.isFolder) return -1;
                  if (!a.isFolder && b.isFolder) return 1;
                  return a.name.localeCompare(b.name);
                });

                return sortedChildren.map(child => {
                  const isOpen = openFolders[child.path] !== false;
                  const paddingLeft = `${depth * 10 + 6}px`;

                  if (child.isFolder) {
                    const hasStale = child.isFileBroken;
                    return (
                      <div key={child.path} style={{ display: 'flex', flexDirection: 'column' }}>
                        <div 
                          onClick={() => toggleFolder(child.path)}
                          className="sidebar-folder-item"
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '5px 8px',
                            paddingLeft,
                            fontSize: '11px',
                            cursor: 'pointer',
                            borderRadius: '4px',
                            color: hasStale ? 'var(--status-broken)' : 'var(--text-secondary)',
                            transition: 'all 0.15s ease',
                            userSelect: 'none'
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            <span style={{ 
                              transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', 
                              transition: 'transform 0.15s ease',
                              display: 'inline-block',
                              fontSize: '8px',
                              opacity: 0.5
                            }}>
                              ▶
                            </span>
                            <span style={{ fontSize: '12px' }}>📁</span>
                            <span style={{ 
                              fontWeight: hasStale ? 600 : 'normal',
                              textDecoration: hasStale ? 'underline dotted' : 'none'
                            }}>
                              {child.name}
                            </span>
                          </div>
                          {hasStale && (
                            <span className="badge badge-broken" style={{ fontSize: '7.5px', padding: '1px 4px', borderRadius: '3px', fontWeight: 600 }}>
                              stale
                            </span>
                          )}
                        </div>
                        {isOpen && renderTree(child, depth + 1)}
                      </div>
                    );
                  } else {
                    const isSelected = selectedNode?.id === child.file.id;
                    const hasStale = child.isFileBroken;
                    return (
                      <div 
                        key={child.path}
                        className={`sidebar-file-item ${isSelected ? 'active' : ''}`}
                        onClick={() => {
                          setActiveTab('visualizer');
                          const physNode = nodesRef.current.find(n => n.id === child.file.id);
                          if (physNode) focusOnNode(physNode);
                        }}
                        style={{ 
                          border: 'none', 
                          padding: '5px 8px', 
                          paddingLeft: `${depth * 10 + 20}px`, 
                          fontSize: '11.5px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          cursor: 'pointer',
                          borderRadius: '4px',
                          color: hasStale ? 'var(--status-broken)' : 'var(--text-primary)',
                          background: isSelected ? 'var(--bg-hover)' : 'transparent',
                          transition: 'all 0.15s ease'
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          <span style={{ fontSize: '11px' }}>📄</span>
                          <span style={{ 
                            fontWeight: hasStale ? 600 : 'normal',
                            textDecoration: hasStale ? 'underline dotted' : 'none'
                          }}>
                            {child.name}
                          </span>
                        </div>
                        <span className={`badge ${hasStale ? 'badge-broken' : 'badge-valid'}`} style={{ fontSize: '7.5px', padding: '1px 4px', borderRadius: '3px' }}>
                          {hasStale ? 'stale' : 'intact'}
                        </span>
                      </div>
                    );
                  }
                });
              };

              return renderTree(root);
            })()}
          </div>
        </div>
      </div>

      {/* ─── Main Content Workspace ─── */}
      <div className="workspace">
        
        {/* Workspace Shared Header Banner */}
        <div className="workspace-header" style={{ borderBottom: '1px solid #1f1f23', backgroundColor: '#000000' }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {isSidebarCollapsed && (
              <button 
                onClick={() => setIsSidebarCollapsed(false)}
                className="btn"
                style={{
                  background: 'transparent',
                  border: '1px solid #1f1f23',
                  padding: '6px 10px',
                  marginRight: '12px',
                  display: 'flex',
                  alignItems: 'center'
                }}
                title="Expand Sidebar (Ctrl+B)"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
              </button>
            )}
            <div className="workspace-title">
              <span>
                {activeTab === 'verify' && 'Handover'}
                {activeTab === 'visualizer' && 'Interactive Circuit Visualizer'}
                {activeTab === 'ledger' && 'Rationale Ledger (ADRs)'}
              </span>
              <span className={`badge ${isDriftBlocked() ? 'badge-broken' : 'badge-valid'}`} style={{ marginLeft: '4px' }}>
                Handover Score: {getHealthPercent()}%
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '10px' }}>
            {isDriftBlocked() ? (
              <span className="badge badge-broken">[DESYNC] Agent Context Desynchronized</span>
            ) : (
              <span className="badge badge-valid">[SECURE] Handover Context Hydrated</span>
            )}
          </div>
        </div>

        {/* Dynamic Workspaces Body */}
        <div className="workspace-body" style={{ backgroundColor: '#000000' }}>



          {/* WORKSPACE 1: Handover Integrity Guard */}
          {activeTab === 'verify' && (
            <div className="verify-container">
              {/* Left Panel: Active Handover Warnings Feed */}
              <div className="verify-panel-left" style={{ borderRight: '1px solid #1f1f23' }}>
                <div className="sidebar-section-title" style={{ padding: '16px 16px 4px 16px', margin: 0, fontSize: '9px', color: '#56565a' }}>
                  Handover Integrity Alerts ({getDriftItems().length})
                </div>
                <div className="drift-feed">
                  {getDriftItems().map((item) => (
                    <div 
                      key={item.conceptId}
                      className={`drift-card ${selectedDriftViolation?.conceptId === item.conceptId ? 'active' : ''}`}
                      onClick={() => setSelectedDriftViolation(item)}
                      style={{ border: '1px solid #1f1f23', background: '#09090b', borderRadius: '8px' }}
                    >
                      <div className="card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                        <span style={{ fontWeight: 600 }}>{item.conceptLabel}</span>
                        <span className="badge badge-broken" style={{ fontSize: '9px', padding: '1px 4px' }}>DESYNC</span>
                      </div>
                      <p className="card-desc" style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                        File: <span style={{ color: '#fafafa', fontFamily: 'var(--font-mono)' }}>{item.filePath}</span>
                      </p>
                      {item.governingADRLabel && (
                        <p className="card-desc" style={{ fontSize: '10px', color: 'var(--accent-gold)', marginTop: '4px', fontWeight: 500 }}>
                          Governed by: {item.governingADRLabel}
                        </p>
                      )}
                    </div>
                  ))}
                  {getDriftItems().length === 0 && (
                    <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
                      <div style={{ fontSize: '18px', marginBottom: '8px', color: 'var(--status-valid)', fontWeight: 'bold' }}>[OK]</div>
                      <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>Repository Fully Secure</div>
                      <div style={{ fontSize: '11px', marginTop: '4px', color: 'var(--text-secondary)' }}>All cryptographic Merkle bindings match active design rationales. Safe to commit.</div>
                    </div>
                  )}
                </div>
              </div>

              {/* Right Panel: Side-by-Side Detailed Compare Rationale */}
              <div className="verify-panel-right">
                <div style={{
                  background: 'rgba(255, 255, 255, 0.01)',
                  border: '1px solid #1f1f23',
                  borderRadius: '8px',
                  padding: '16px',
                  marginBottom: '20px',
                  display: 'flex',
                  gap: '12px',
                  alignItems: 'flex-start'
                }}>
                  <div style={{
                    width: '28px',
                    height: '28px',
                    borderRadius: '50%',
                    backgroundColor: '#18181b',
                    border: '1px solid #27272a',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--accent-gold)',
                    fontWeight: '700',
                    fontSize: '11px',
                    fontFamily: 'var(--font-mono)',
                    flexShrink: 0
                  }}>
                    AI
                  </div>
                  <div>
                    <h4 style={{ fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                      REPONOESIS KNOWLEDGE ASSISTANT
                    </h4>
                    <p style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.4', margin: 0 }}>
                      {getDriftItems().length > 0 
                        ? `Auditing handover state... I detected ${getDriftItems().length} changes that violate your documented Architecture Decision Records. Switch tabs or review the design rationales below to re-align your codebase before model handover.`
                        : "Greetings! I've audited the repository. The handover context and ADR decisions are 100% healthy. You are ready to pack and transfer the handover context to another model or agent!"
                      }
                    </p>
                  </div>
                </div>

                {selectedDriftViolation ? (
                  <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100% - 80px)', gap: '16px' }}>
                    <div>
                      <span className="badge badge-broken" style={{ textTransform: 'uppercase', marginBottom: '8px', background: selectedDriftViolation.isSemanticViolation ? 'rgba(249, 115, 22, 0.2)' : 'rgba(239, 68, 68, 0.2)', color: selectedDriftViolation.isSemanticViolation ? '#f97316' : '#ef4444', border: selectedDriftViolation.isSemanticViolation ? '1px solid #f97316' : '1px solid #ef4444' }}>
                        {selectedDriftViolation.isSemanticViolation ? 'AI Semantic Contradiction' : 'Context Desynchronization Detail'}
                      </span>
                      <h2 style={{ fontSize: '17px', fontWeight: 700, letterSpacing: '-0.02em', margin: '0 0 4px 0' }}>
                        {selectedDriftViolation.isSemanticViolation ? `AI Contradiction: "${selectedDriftViolation.conceptLabel}"` : `Handover Context Desync: "${selectedDriftViolation.conceptLabel}"`}
                      </h2>
                      <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-secondary)' }}>
                        {selectedDriftViolation.isSemanticViolation ? 'Conflicting Files: ' : 'File source: '}<span style={{ fontFamily: 'var(--font-mono)', color: '#fafafa' }}>{selectedDriftViolation.filePath}</span>
                      </p>
                    </div>

                    {/* Drift Explanation Banner */}
                    {selectedDriftViolation.driftExplanation && (
                      <div style={{
                        background: selectedDriftViolation.isSemanticViolation ? 'rgba(249, 115, 22, 0.08)' : 'rgba(239, 68, 68, 0.08)',
                        border: selectedDriftViolation.isSemanticViolation ? '1px solid rgba(249, 115, 22, 0.3)' : '1px solid rgba(239, 68, 68, 0.3)',
                        borderRadius: '8px',
                        padding: '12px 14px',
                        display: 'flex',
                        gap: '10px',
                        alignItems: 'flex-start',
                      }}>
                        <span style={{ fontSize: '16px', flexShrink: 0 }}>⚠️</span>
                        <div>
                          <div style={{ fontSize: '9px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: selectedDriftViolation.isSemanticViolation ? '#f97316' : '#ef4444', marginBottom: '4px' }}>
                            {selectedDriftViolation.isSemanticViolation ? 'Contradiction Reason' : "Why it's broken"}
                          </div>
                          <div style={{ fontSize: '12px', color: selectedDriftViolation.isSemanticViolation ? '#ffedd5' : '#fca5a5', lineHeight: '1.5' }}>{selectedDriftViolation.driftExplanation}</div>
                        </div>
                      </div>
                    )}

                    {/* Side-by-Side Split Code compare */}
                    <div className="compare-grid">
                      {/* Left: Code Block */}
                      <div className="compare-pane" style={{ border: '1px solid #1f1f23' }}>
                        <div className="compare-pane-header" style={{ borderBottom: '1px solid #1f1f23' }}>
                          <span>{selectedDriftViolation.isSemanticViolation ? 'AI Audit Rationale' : 'Modified Code Segment'}</span>
                        </div>
                        <div className="compare-pane-body" style={{ backgroundColor: '#020203', overflowY: 'auto' }}>
                          {selectedDriftViolation.isSemanticViolation ? (
                            <div style={{ padding: '14px', fontSize: '12px', lineHeight: '1.6', color: '#f4f4f5', fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap' }}>
                              <div style={{ color: '#ef4444', fontWeight: 600, marginBottom: '6px', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Desync Conflict:</div>
                              {selectedDriftViolation.driftExplanation}
                            </div>
                          ) : (
                            highlightCodeViolation(selectedDriftViolation.sectionText, selectedDriftViolation.conceptLabel)
                          )}
                        </div>
                      </div>

                      {/* Right: Governing ADR Ledger Document */}
                      <div className="compare-pane" style={{ border: '1px solid #1f1f23' }}>
                        <div className="compare-pane-header" style={{ borderBottom: '1px solid #1f1f23' }}>
                          <span>{selectedDriftViolation.isSemanticViolation ? 'AI Proposed Fix' : 'Governing ADR Rationale'}</span>
                        </div>
                        <div className="compare-pane-body" style={{ overflowY: 'auto' }}>
                          {selectedDriftViolation.isSemanticViolation ? (
                            <div className="doc-content" style={{ marginTop: 0, padding: '14px' }}>
                              <h3 style={{ fontSize: '13px', fontWeight: 600, color: '#f97316', marginBottom: '8px' }}>
                                Agent Proposed Semantic Fix
                              </h3>
                              <pre style={{
                                background: '#09090b',
                                border: '1px solid #27272a',
                                padding: '10px',
                                borderRadius: '6px',
                                fontSize: '10.5px',
                                fontFamily: 'var(--font-mono)',
                                color: '#f4f4f5',
                                overflowX: 'auto',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-all',
                                lineHeight: '1.4',
                              }}>
                                {selectedDriftViolation.proposedFix}
                              </pre>
                            </div>
                          ) : selectedDriftViolation.governingADRLabel ? (
                            (() => {
                              const adr = data?.decisions?.find(d => d.label === selectedDriftViolation.governingADRLabel);
                              if (adr) {
                                return (
                                  <div className="doc-content" style={{ marginTop: 0 }}>
                                    <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--accent-gold)', marginBottom: '8px' }}>
                                      {adr.title}
                                    </h3>
                                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
                                      Status: <span className="badge badge-valid" style={{ fontSize: '9px', padding: '1px 4px' }}>{adr.status}</span>
                                    </div>
                                    <div style={{ fontSize: '12px', lineHeight: '1.5', color: 'var(--text-secondary)' }}>
                                      {adr.body.split('\n').filter(l => !l.startsWith('# ') && !l.startsWith('## ')).slice(0, 8).join('\n')}...
                                    </div>
                                    <button 
                                      className="btn" 
                                      style={{ marginTop: '16px', width: '100%', fontSize: '11px', border: '1px solid #1f1f23', background: 'transparent' }}
                                      onClick={() => {
                                        const matchADR = data?.decisions?.find(d => d.label === selectedDriftViolation.governingADRLabel);
                                        if (matchADR) {
                                          setSelectedADR(matchADR);
                                          setActiveTab('ledger');
                                        }
                                      }}
                                    >
                                      Read Full ADR Document
                                    </button>
                                  </div>
                                );
                              }
                              return <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>ADR context details not loaded.</div>;
                            })()
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-secondary)', textAlign: 'center', padding: '20px' }}>
                              <div style={{ fontSize: '20px', marginBottom: '8px' }}>[!]</div>
                              <div style={{ fontSize: '11px' }}>No explicit Architecture Decision Record (ADR) governs this code section yet.</div>
                              <button 
                                className="btn" 
                                style={{ marginTop: '12px', fontSize: '11px', border: '1px solid #1f1f23' }}
                                onClick={() => {
                                  setActiveTab('ledger');
                                }}
                              >
                                Bind an ADR Decision Now
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Actions Panel */}
                    <div style={{ display: 'flex', gap: '12px', borderTop: '1px solid #1f1f23', paddingTop: '16px' }}>
                      <button 
                        className="btn btn-primary"
                        onClick={() => {
                          alert('Context desync resolved in local memory graph. Verify passed!');
                          setSimulatedBrokenConceptIds(prev => {
                            const next = new Set(prev);
                            next.delete(selectedDriftViolation.conceptId);
                            return next;
                          });
                        }}
                      >
                        Acknowledge Context Desync
                      </button>
                      <button 
                        className="btn"
                        style={{ border: '1px solid #1f1f23', background: 'transparent' }}
                        onClick={() => {
                          setActiveTab('visualizer');
                          const node = nodesRef.current.find(n => n.id === selectedDriftViolation.conceptId);
                          if (node) focusOnNode(node);
                        }}
                      >
                        Locate in Force Visualizer
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', overflowY: 'auto', height: '100%', paddingRight: '8px' }}>
                    {/* Handover Core Status Banner */}
                    <div style={{
                      background: '#09090b',
                      border: '1px solid #1f1f23',
                      borderRadius: '8px',
                      padding: '24px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '12px'
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <h3 style={{ fontSize: '14px', fontWeight: 600, color: '#f4f4f5', fontFamily: 'var(--font-mono)' }}>
                          STATUS: {getDriftItems().length > 0 ? 'SEMANTIC DRIFT DETECTED' : 'INTEGRITY SECURE'}
                        </h3>
                        <span className={`badge ${getDriftItems().length > 0 ? 'badge-broken' : 'badge-valid'}`}>
                          {getDriftItems().length > 0 ? `${getDriftItems().length} ALERTS ACTIVE` : 'READY FOR HANDOFF'}
                        </span>
                      </div>
                    </div>

                    {/* Workspace Telemetry Data Card */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                      <div style={{ background: '#09090b', border: '1px solid #1f1f23', borderRadius: '8px', padding: '16px' }}>
                        <div style={{ fontSize: '10px', fontWeight: 600, color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
                          Scanned Telemetry
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px dashed #1f1f23', paddingBottom: '4px' }}>
                            <span style={{ color: '#a1a1aa' }}>Total Scanned Files:</span>
                            <span style={{ fontWeight: 600, color: '#f4f4f5', fontFamily: 'var(--font-mono)' }}>{data?.files.length || 0}</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px dashed #1f1f23', paddingBottom: '4px' }}>
                            <span style={{ color: '#a1a1aa' }}>Semantic Concept Anchors:</span>
                            <span style={{ fontWeight: 600, color: '#f4f4f5', fontFamily: 'var(--font-mono)' }}>{data?.concepts.length || 0}</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: '#a1a1aa' }}>Governing ADR Records:</span>
                            <span style={{ fontWeight: 600, color: '#f4f4f5', fontFamily: 'var(--font-mono)' }}>{data?.decisions?.length || 0}</span>
                          </div>
                        </div>
                      </div>

                      <div style={{ background: '#09090b', border: '1px solid #1f1f23', borderRadius: '8px', padding: '16px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                        <div style={{ fontSize: '10px', fontWeight: 600, color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
                          Verification Score
                        </div>
                        <div style={{ fontSize: '28px', fontWeight: 700, color: getDriftItems().length > 0 ? 'var(--status-drift)' : 'var(--status-valid)', fontFamily: 'var(--font-mono)' }}>
                          {getHealthPercent()}%
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* RATIONALE LEDGER */}
          {activeTab === 'ledger' && (
            <div className="ledger-container">
              {/* Left Sub-Panel: Decisions List */}
              <div className="ledger-list" style={{ borderRight: '1px solid #1f1f23' }}>
                <input
                  type="text"
                  placeholder="Search ADRs..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{
                    width: '100%',
                    backgroundColor: '#020203',
                    border: '1px solid #1f1f23',
                    color: '#f4f4f5',
                    padding: '6px 10px',
                    borderRadius: '4px',
                    fontSize: '12px',
                    outline: 'none',
                    marginBottom: '6px',
                  }}
                />
                {(data?.decisions || []).filter(d => d.label.toLowerCase().includes(searchQuery.toLowerCase())).map((adr) => (
                  <div 
                    key={adr.id}
                    className={`ledger-card ${selectedADR?.id === adr.id ? 'active' : ''}`}
                    onClick={() => setSelectedADR(adr)}
                    style={{ border: '1px solid #1f1f23', background: '#09090b' }}
                  >
                    <div className="card-title" style={{ fontSize: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                      <span style={{ fontWeight: 600 }}>{adr.label}</span>
                      <span className="badge badge-valid" style={{ fontSize: '8px', padding: '1px 3px' }}>{adr.status}</span>
                    </div>
                    <div className="card-desc" style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {adr.title}
                    </div>
                  </div>
                ))}
                {(data?.decisions || []).length === 0 && (
                  <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '11px' }}>
                    No decisions registered. Run: rpn decide {'<label>'}
                  </div>
                )}
              </div>

              {/* Right Sub-Panel: Document Viewer */}
              <div style={{ flex: 1, overflow: 'hidden', backgroundColor: '#000000' }}>
                {selectedADR ? (
                  <div className="doc-reader" style={{ backgroundColor: '#000000' }}>

                    <div className="doc-header" style={{ borderBottom: '1px solid #1f1f23' }}>
                      <span className="badge badge-valid" style={{ textTransform: 'uppercase', marginBottom: '8px' }}>Active ADR Document</span>
                      <h1 className="doc-title">{selectedADR.title}</h1>
                      <div className="doc-meta">
                        <span>Label: <strong style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{selectedADR.label}</strong></span>
                        <span>•</span>
                        <span>Status: <span className="badge badge-valid">{selectedADR.status}</span></span>
                      </div>
                    </div>

                    <div className="doc-content">
                      {renderADRText(selectedADR.body)}
                    </div>

                    {/* Linked Files governed by this decision */}
                    <div style={{ marginTop: '40px', borderTop: '1px solid #1f1f23', paddingTop: '24px' }}>
                      <h3 style={{ fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', marginBottom: '10px' }}>
                        Governed Files (Merkle Bound)
                      </h3>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                        {(data?.decisionLinks?.filter(l => l.decisionId === selectedADR.id) || []).map((link) => {
                          const file = data?.files.find(f => f.id === link.fileId);
                          if (!file) return null;
                          const name = file.path.split(/[\\/]/).pop() || file.path;
                          return (
                            <span 
                              key={link.fileId} 
                              className="pill"
                              style={{ border: '1px solid #1f1f23', background: 'transparent' }}
                              onClick={() => {
                                setActiveTab('visualizer');
                                const physNode = nodesRef.current.find(n => n.id === file.id);
                                if (physNode) focusOnNode(physNode);
                              }}
                            >
                              [FILE] {name} {link.chainState === 'CHAIN_BROKEN' ? '[Drift]' : ''}
                            </span>
                          );
                        })}
                        {(data?.decisionLinks?.filter(l => l.decisionId === selectedADR.id) || []).length === 0 && (
                          <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                            No files cryptographically bound to this decision yet.
                          </div>
                        )}
                      </div>
                      
                      {/* Show Agent Brain drift explanations if any exist */}
                      {(() => {
                        const brokenLinks = (data?.decisionLinks?.filter(l => l.decisionId === selectedADR.id && l.chainState === 'CHAIN_BROKEN' && l.driftExplanation) || []);
                        if (brokenLinks.length === 0) return null;
                        return (
                          <div style={{ marginTop: '20px', padding: '14px 18px', borderRadius: '8px', border: '1px dashed #ef4444', backgroundColor: 'rgba(239, 68, 68, 0.05)' }}>
                            <div style={{ fontSize: '10px', fontWeight: 700, color: '#ef4444', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                              Drift Insights (Agent Brain Verified)
                            </div>
                            {brokenLinks.map((link) => {
                              const file = data?.files.find(f => f.id === link.fileId);
                              const name = file ? file.path.split(/[\\/]/).pop() : 'file';
                              return (
                                <div key={link.fileId} style={{ fontSize: '12px', color: '#e4e4e7', lineHeight: '1.6', marginBottom: '4px' }}>
                                  <strong style={{ color: '#ef4444' }}>{name}:</strong> {link.driftExplanation}
                                </div>
                              );
                            })}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-secondary)' }}>
                    <div style={{ fontSize: '28px', marginBottom: '12px', opacity: 0.5 }}>[d]</div>
                    <div style={{ fontSize: '12px', fontWeight: 500 }}>No ADR Selected</div>
                    <div style={{ fontSize: '11px', marginTop: '4px' }}>Select an architecture decision record on the left to read.</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* CIRCUIT VISUALIZER */}
          <div 
            className={`graph-workspace ${isRightSidebarCollapsed ? 'collapsed' : ''}`}
            style={{ display: activeTab === 'visualizer' ? 'grid' : 'none' }}
          >
            {/* Visualizer Canvas Area */}
            {/* Visualizer Canvas Area */}
            <div className="graph-container" style={{ position: 'relative', overflow: 'hidden' }}>
              {/* Floating Layout controls toolbar */}
              <div style={{ position: 'absolute', top: '16px', left: '16px', zIndex: 10, display: 'flex', gap: '8px', alignItems: 'center' }}>
                <select
                  value={graphDensity}
                  onChange={(e) => {
                    setGraphDensity(e.target.value as any);
                    alphaRef.current = 1.0; 
                  }}
                  style={{
                    backgroundColor: 'rgba(18, 18, 22, 0.85)',
                    border: '1px solid #1f1f23',
                    color: 'var(--text-primary)',
                    padding: '6px 12px',
                    borderRadius: '6px',
                    fontSize: '11px',
                    cursor: 'pointer',
                    outline: 'none',
                  }}
                >
                  <option value="files">Architecture (Files Only)</option>
                  <option value="concepts">Concepts Map</option>
                  <option value="all">Full Engineering Map</option>
                </select>
                <button
                  className="btn"
                  style={{ border: '1px solid #1f1f23', background: 'transparent' }}
                  onClick={() => {
                    centerGraph();
                    alphaRef.current = 1.0;
                  }}
                >
                  Reset View
                </button>
                <button
                  className="btn"
                  style={{ border: '1px solid #1f1f23', background: 'transparent', width: '28px', padding: '0', height: '28px' }}
                  onClick={() => {
                    setZoom(z => Math.max(0.4, z - 0.1));
                  }}
                  title="Zoom Out"
                >
                  -
                </button>
                <span style={{ fontSize: '10px', color: '#71717a', fontFamily: 'var(--font-mono)', minWidth: '32px', textAlign: 'center' }}>
                  {Math.round(zoom * 100)}%
                </span>
                <button
                  className="btn"
                  style={{ border: '1px solid #1f1f23', background: 'transparent', width: '28px', padding: '0', height: '28px' }}
                  onClick={() => {
                    setZoom(z => Math.min(2.0, z + 0.1));
                  }}
                  title="Zoom In"
                >
                  +
                </button>
                <button
                  className={`btn ${isRightSidebarCollapsed ? 'btn-primary' : ''}`}
                  style={{ border: '1px solid #1f1f23' }}
                  onClick={() => setIsRightSidebarCollapsed(prev => !prev)}
                  title="Toggle Inspector Sidebar"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '4px' }}><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
                  {isRightSidebarCollapsed ? 'Show Inspector' : 'Hide Inspector'}
                </button>
                <button
                  className={`btn ${isFocusMode ? 'btn-primary' : ''}`}
                  style={{ border: '1px solid #1f1f23' }}
                  onClick={() => {
                    const nextFocus = !isFocusMode;
                    setIsFocusMode(nextFocus);
                    if (nextFocus) {
                      setIsSidebarCollapsed(true);
                      setIsRightSidebarCollapsed(true);
                    } else {
                      setIsSidebarCollapsed(false);
                      setIsRightSidebarCollapsed(false);
                    }
                  }}
                  title="Toggle Focus Mode"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '4px' }}><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
                  Focus Mode
                </button>
              </div>

              {/* Scrollable PCB Board container */}
              <div 
                ref={canvasScrollWrapperRef}
                style={{
                  width: '100%',
                  height: '100%',
                  overflow: 'auto',
                  position: 'relative',
                  backgroundColor: '#050506'
                }}
              >
                <canvas
                  ref={canvasRef}
                  width={1800}
                  height={1200}
                  style={{
                    width: '1800px',
                    height: '1200px',
                    display: 'block',
                    backgroundColor: '#050506',
                    outline: 'none'
                  }}
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                  onMouseLeave={handleMouseUp}
                  onDoubleClick={handleDoubleClick}
                />

                {/* Floating POP-OVER Overlay for Broken Concepts (rendered inside scrollable area) */}
                {selectedNode && selectedNode.type === 'concept' && (selectedNode.status === 'CHAIN_BROKEN' || simulatedBrokenConceptIds.has(selectedNode.id)) && (
                  <div style={{
                    position: 'absolute',
                    left: `${900 + (selectedNode.x - 900) * zoom}px`,
                    top: `${600 + (selectedNode.y - 600) * zoom - 20}px`,
                    transform: 'translate(-50%, -100%)',
                    width: '280px',
                    backgroundColor: 'rgba(18, 18, 22, 0.92)',
                    border: '1px solid var(--status-broken)',
                    backdropFilter: 'var(--backdrop-blur)',
                    borderRadius: '8px',
                    padding: '12px',
                    boxShadow: '0 8px 30px rgba(0,0,0,0.65)',
                    zIndex: 200,
                    pointerEvents: 'auto',
                    transition: 'left 0.1s ease, top 0.1s ease'
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                      <span style={{ fontSize: '10px', color: '#ef4444', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.05em' }}>[MERKLE DRIFT EXPOSURE]</span>
                      <button 
                        onClick={() => { setSelectedNode(null); setImpactedNodeIds(new Set()); }}
                        style={{ background: 'none', border: 'none', color: '#71717a', cursor: 'pointer', fontSize: '10px' }}
                      >
                        Dismiss
                      </button>
                    </div>
                    <h4 style={{ fontSize: '12px', fontWeight: 600, color: '#f4f4f5', margin: '0 0 4px 0' }}>{selectedNode.label}</h4>
                    <p style={{ fontSize: '10px', color: '#a1a1aa', margin: '0 0 8px 0', lineHeight: '1.4' }}>
                      Hash desynchronization has broken context continuity down to active governed dependencies.
                    </p>
                    <div style={{ fontSize: '9px', fontFamily: 'var(--font-mono)', backgroundColor: '#020203', border: '1px solid rgba(255,255,255,0.04)', borderRadius: '4px', padding: '6px', wordBreak: 'break-all', color: '#ef4444' }}>
                      LINK: {selectedNode.chainLink || 'simulated_drift_mutation_hash'}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Visualizer Right sidebar inspector */}
            <div className="graph-sidebar" style={{ borderLeft: '1px solid #1f1f23' }}>
              <div className="sidebar-section-title" style={{ padding: '16px 16px 4px 16px', margin: 0, fontSize: '9px', color: '#56565a' }}>
                Circuit Board Inspector
              </div>
              <div style={{ flex: 1, padding: '16px', overflowY: 'auto', maxHeight: 'calc(100vh - 120px)' }}>
                {selectedNode ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <div>
                      <span className="badge" style={{ textTransform: 'uppercase', marginBottom: '8px', fontSize: '9px' }}>
                        {selectedNode.type} node
                      </span>
                      <h3 style={{ margin: '0 0 6px 0', fontSize: '13px', fontWeight: 600, wordBreak: 'break-all' }}>{selectedNode.label}</h3>
                      {selectedNode.filePath && (
                        <p style={{ margin: 0, fontSize: '10px', color: 'var(--text-secondary)', wordBreak: 'break-all', fontFamily: 'var(--font-mono)' }}>
                          {selectedNode.filePath.split(/[\\/]/).pop()}
                        </p>
                      )}
                    </div>

                    {/* Active Drift Violations for File Node */}
                    {selectedNode.type === 'file' && (() => {
                      const fileDLs = data?.decisionLinks?.filter(l => l.fileId === selectedNode.id && l.chainState === 'CHAIN_BROKEN') || [];
                      if (fileDLs.length === 0) return null;
                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', border: '1px dashed #ef4444', borderRadius: '8px', padding: '12px', backgroundColor: 'rgba(239, 68, 68, 0.05)' }}>
                          <span style={{ fontSize: '9px', fontWeight: 'bold', color: '#ef4444', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                            Active Drift Violations
                          </span>
                          {fileDLs.map((link) => {
                            const decision = data?.decisions.find(d => d.id === link.decisionId);
                            const section = data?.sections.find(s => s.id === link.sectionId);
                            const lineRange = section ? `Lines ${section.lineStart}-${section.lineEnd}` : 'Lines 1-end';
                            return (
                              <div key={link.decisionId} style={{ fontSize: '11px', borderBottom: '1px solid rgba(239, 68, 68, 0.1)', paddingBottom: '8px', marginBottom: '8px' }}>
                                <div style={{ color: '#ef4444', fontWeight: 600 }}>{lineRange}</div>
                                <div style={{ color: '#e4e4e7', marginTop: '2px' }}>
                                  ADR: <strong style={{ color: 'var(--text-primary)' }}>{decision?.label}</strong> ("{decision?.title}")
                                </div>
                                {link.driftExplanation && (
                                  <div style={{ color: '#a1a1aa', marginTop: '6px', fontSize: '10.5px', lineHeight: '1.4', fontStyle: 'italic', backgroundColor: 'rgba(0,0,0,0.2)', padding: '6px', borderRadius: '4px', borderLeft: '2px solid #ef4444' }}>
                                    {link.driftExplanation}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}

                    {/* Bind status details */}
                    {selectedNode.type === 'decision' && (
                      <div className="code-block" style={{ fontSize: '10px', border: '1px solid #1f1f23' }}>
                        <strong>ADR TITLE:</strong> {selectedNode.decisionTitle}<br/>
                        <strong>STATUS:</strong> {selectedNode.decisionStatus}
                      </div>
                    )}

                    {selectedNode.rawText && (
                      <div>
                        <span className="sidebar-section-title" style={{ padding: 0 }}>Raw Context snippet</span>
                        {(() => {
                          const lines = selectedNode.rawText.split('\n');
                          const start = selectedNode.lineStart || 1;
                          
                          // Check if this section is involved in any active contradictions or drift
                          const sectionViolations = data?.semanticViolations?.filter(
                            v => v.sectionAId === selectedNode.id || v.sectionBId === selectedNode.id
                          ) || [];
                          
                          const fileDLs = data?.decisionLinks?.filter(
                            l => l.sectionId === selectedNode.id && l.chainState === 'CHAIN_BROKEN'
                          ) || [];
                          
                          const isStale = sectionViolations.length > 0 || fileDLs.length > 0;
                          
                          return (
                            <div style={{ 
                              maxHeight: '200px', 
                              overflowY: 'auto', 
                              backgroundColor: '#0a0a0c', 
                              border: isStale ? '1px solid var(--status-broken)' : '1px solid #1f1f23',
                              borderRadius: '6px', 
                              padding: '8px 0', 
                              fontFamily: 'monospace', 
                              fontSize: '11px',
                              lineHeight: '1.5',
                              marginTop: '6px'
                            }}>
                              {lines.map((line, idx) => {
                                const lineNum = start + idx;
                                
                                // Determine if this specific line should be highlighted
                                const isHighlight = isStale && (
                                  line.includes('MAX_RETRIES') || 
                                  line.includes('DB_POOL_SIZE') || 
                                  line.includes('DAILY_LIMIT') || 
                                  line.includes('validatePassword') || 
                                  line.includes('FREE_STORAGE_GB') || 
                                  line.includes('SESSION_EXPIRY') ||
                                  line.includes('AUTH_TOKEN_EXPIRY') ||
                                  line.includes('TOKEN_EXPIRY') ||
                                  line.includes('SERVER_PORT') || 
                                  line.includes('proxy_read_timeout') || 
                                  line.includes('requestTimeout') ||
                                  line.includes('VERSION') || 
                                  line.includes('GRACE_PERIOD_DAYS') ||
                                  line.includes('30 days') ||
                                  line.includes('90 days') ||
                                  line.includes('validate') ||
                                  line.includes('passwordCheck') ||
                                  line.includes('password.length')
                                );

                                return (
                                  <div 
                                    key={idx} 
                                    style={{ 
                                      display: 'flex', 
                                      backgroundColor: isHighlight ? 'rgba(239, 68, 68, 0.12)' : 'transparent',
                                      borderLeft: isHighlight ? '3px solid var(--status-broken)' : '3px solid transparent',
                                      paddingRight: '12px'
                                    }}
                                  >
                                    <div style={{ 
                                      width: '32px', 
                                      textAlign: 'right', 
                                      paddingRight: '8px', 
                                      color: isHighlight ? '#ef4444' : '#4b4b50', 
                                      userSelect: 'none', 
                                      borderRight: '1px solid #1f1f23',
                                      marginRight: '8px',
                                      fontWeight: isHighlight ? 'bold' : 'normal'
                                    }}>
                                      {lineNum}
                                    </div>
                                    <div style={{ 
                                      whiteSpace: 'pre', 
                                      color: isHighlight ? '#ef4444' : '#d4d4d8',
                                      fontWeight: isHighlight ? '600' : 'normal'
                                    }}>
                                      {line}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })()}
                      </div>
                    )}

                    {selectedNode.chainLink && (
                      <div>
                        <span className="sidebar-section-title" style={{ padding: 0 }}>Merkle chain Link</span>
                        <div className="code-block" style={{ fontSize: '9px', wordBreak: 'break-all', marginTop: '6px', border: '1px solid #1f1f23' }}>
                          {selectedNode.chainLink}
                        </div>
                      </div>
                    )}

                    {/* Downstream Blast radius display */}
                    {impactedNodeIds.size > 1 && (
                      <div>
                        <span className="sidebar-section-title" style={{ padding: 0 }}>Downstream Blast impact ({impactedNodeIds.size - 1})</span>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px', maxHeight: '200px', overflowY: 'auto' }}>
                          {Array.from(impactedNodeIds).map((id) => {
                            if (id === selectedNode.id) return null;
                            const match = nodesRef.current.find(n => n.id === id);
                            if (!match) return null;
                            const isMatchBroken = match.status === 'CHAIN_BROKEN' || simulatedBrokenConceptIds.has(id);
                            return (
                              <div 
                                key={id} 
                                className="sidebar-file-item"
                                style={{ fontSize: '11px', padding: '4px 8px', background: 'rgba(255,255,255,0.01)' }}
                                onClick={() => focusOnNode(match)}
                              >
                                <span>{match.label}</span>
                                <span className={`badge ${isMatchBroken ? 'badge-broken' : 'badge-valid'}`} style={{ fontSize: '8px' }}>
                                  {isMatchBroken ? 'stale' : 'intact'}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '80%', color: 'var(--text-secondary)', textAlign: 'center' }}>
                    <div style={{ fontSize: '20px', marginBottom: '8px', opacity: 0.5 }}>[o]</div>
                    <div style={{ fontSize: '11px', lineHeight: '1.4' }}>Click any node on the force graph circuit to inspect its Merkle bindings. Double-click file bubbles to expand scope channels.</div>
                  </div>
                )}
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
