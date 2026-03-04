declare module 'three/addons/lines/Line2.js' {
    export * from 'three/examples/jsm/lines/Line2';
}
declare module 'three/addons/lines/LineMaterial.js' {
    export * from 'three/examples/jsm/lines/LineMaterial';
}
declare module 'three/addons/lines/LineGeometry.js' {
    export * from 'three/examples/jsm/lines/LineGeometry';
}

declare module 'three/examples/jsm/lines/Line2' {
    import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2';
    import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry';
    import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial';
    export class Line2 extends LineSegments2 {
        constructor(geometry?: LineGeometry, material?: LineMaterial);
        readonly isLine2: true;
    }
}

declare module 'three/examples/jsm/lines/LineMaterial' {
    import { ShaderMaterial, Vector2, Color, ShaderMaterialParameters } from 'three';
    export interface LineMaterialParameters extends ShaderMaterialParameters {
        color?: number | string | Color;
        dashed?: boolean;
        dashScale?: number;
        dashSize?: number;
        dashOffset?: number;
        gapSize?: number;
        linewidth?: number;
        resolution?: Vector2;
        worldUnits?: boolean;
    }
    export class LineMaterial extends ShaderMaterial {
        constructor(parameters?: LineMaterialParameters);
        readonly isLineMaterial: true;
        color: Color;
        dashed: boolean;
        dashScale: number;
        dashSize: number;
        dashOffset: number;
        gapSize: number;
        linewidth: number;
        resolution: Vector2;
        worldUnits: boolean;
    }
}

declare module 'three/examples/jsm/lines/LineGeometry' {
    import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry';
    import { Line2 } from 'three/examples/jsm/lines/Line2';
    export class LineGeometry extends LineSegmentsGeometry {
        constructor();
        readonly isLineGeometry: true;
        fromLine(line: any): this;
    }
}
