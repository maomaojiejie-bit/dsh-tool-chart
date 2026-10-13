/**
 * Parameter and output schema for the `chart` tool.
 *
 * Both are written in `defineTool`'s AUTHOR-SIDE schema DSL, which is not raw
 * JSON Schema:
 *
 * - `parameters` is a plain property map that acts as an implicit OPEN object
 *   root. Never write `type: 'object'` at the root, or the tool would declare
 *   fields literally named "type"/"properties".
 * - Every explicit object node must declare `additionalProperties` by hand.
 * - Requiredness is the literal `true` on the property itself, never an array.
 * - `oneOf` may not carry a sibling `type`.
 *
 * `outputSchema` describes the canonical value only — no colors, no pixel
 * sizes, no renderer settings — so replaying a session needs nothing beyond the
 * persisted JSON. Extra facts live under `stats`.
 */

import type { ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools';

import { CHART_TYPES } from './transform.ts';

export const parameters = {
  type: {
    type: 'string',
    required: true,
    enum: [...CHART_TYPES],
    description: 'Chart type. One of: line, bar, area, scatter, pie, heatmap, candlestick, boxplot.',
  },
  title: { type: 'string', description: 'Chart title shown on the card.' },
  subtitle: { type: 'string', description: 'Optional secondary line under the title.' },
  data: {
    type: 'array',
    description:
      'Inline rows, each a flat object of field -> scalar. Prefer `dataRef` beyond a few hundred rows: inline arrays are paid for in the context window and destabilise the KV cache.',
    items: { type: 'object', additionalProperties: true },
  },
  dataRef: {
    type: 'string',
    description:
      'Rows held outside the arguments, given as a spill file locator (the handle an earlier tool returned). Mutually exclusive with `data`. The host reads it from disk and parses JSON, JSON Lines, or CSV.',
  },
  x: { type: 'string', description: 'Field used for the category / horizontal axis.' },
  y: {
    oneOf: [
      { type: 'string', description: 'One numeric measure field.' },
      {
        type: 'array',
        items: { type: 'string' },
        description: 'Several numeric measure fields; each becomes its own series.',
      },
    ],
    description: 'Numeric field(s) to plot. Required: the host reports a readable error when it is missing.',
  } satisfies ValueSchemaSpec,
  series: {
    type: 'string',
    description:
      'Field whose distinct values become separate series (long -> wide pivot). Cannot be combined with an array-valued `y`.',
  },
  color: {
    type: 'string',
    description: 'Continuous measure field: the plotted value for heatmap, the marker magnitude for scatter.',
  },
  stack: { type: 'boolean', description: 'Stack the series (bar and area only).' },
  sort: {
    type: 'string',
    enum: ['none', 'asc', 'desc'],
    description: 'Sort the category axis by its own value (numeric when parseable, otherwise text).',
  },
  limit: {
    type: 'integer',
    description:
      'Keep at most this many rows before pivoting. When it truncates, the result reports truncated:true and the kept point count.',
  },
  axes: {
    type: 'object',
    additionalProperties: false,
    description: 'Axis presentation hints.',
    properties: {
      xLabel: { type: 'string', description: 'Horizontal axis label.' },
      yLabel: { type: 'string', description: 'Vertical axis label.' },
      yMin: { type: 'number', description: 'Fixed vertical axis minimum.' },
      yMax: { type: 'number', description: 'Fixed vertical axis maximum.' },
    },
  } satisfies ValueSchemaSpec,
  annotations: {
    type: 'array',
    description: 'Horizontal reference markers drawn over the plot.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        x: {
          oneOf: [
            { type: 'string', description: 'An existing category name.' },
            { type: 'number', description: 'A numeric axis position.' },
          ],
          description: 'Where to draw the marker.',
        } satisfies ValueSchemaSpec,
        text: { type: 'string', required: true, description: 'Marker label.' },
        kind: { type: 'string', enum: ['line', 'band'], description: 'Marker style.' },
      },
    },
  } satisfies ValueSchemaSpec,
  theme: {
    type: 'string',
    description: 'Configured theme name (see the plugin config). Defaults to the deployment default.',
  },
  height: { type: 'integer', description: 'Card plot height in pixels, clamped by the deployment config.' },
} satisfies ParameterSchemaSpec;

export const outputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    chartId: { type: 'string', required: true, description: 'Stable identifier of this chart result.' },
    type: { type: 'string', required: true, enum: [...CHART_TYPES], description: 'Chart type that was produced.' },
    title: { type: 'string', description: 'Chart title, when the caller supplied one.' },
    subtitle: { type: 'string', description: 'Chart subtitle, when the caller supplied one.' },
    encoding: {
      type: 'object',
      additionalProperties: false,
      required: true,
      description: 'The field mapping that produced this value.',
      properties: {
        x: { type: 'string', description: 'Field mapped to the horizontal axis.' },
        y: { type: 'array', required: true, items: { type: 'string' }, description: 'Field(s) mapped to the vertical axis.' },
        series: { type: 'string', description: 'Field pivoted into series.' },
        color: { type: 'string', description: 'Field mapped to the colour scale.' },
      },
    } satisfies ValueSchemaSpec,
    series: {
      type: 'array',
      required: true,
      description: 'One entry per drawn series, in draw order.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true, description: 'Series name.' },
          points: {
            type: 'array',
            required: true,
            description: 'Points of this series, in draw order.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                x: { type: 'json', required: true, description: 'Category or numeric position.' },
                y: {
                  type: 'json',
                  required: true,
                  description: 'Numeric value, or an array of numbers for multi-value points.',
                },
                label: { type: 'string', description: 'Optional per-point label.' },
              },
            },
          },
        },
      },
    } satisfies ValueSchemaSpec,
    axes: { type: 'json', description: 'Echoed axis hints.' },
    annotations: { type: 'json', description: 'Echoed annotations, with numeric positions when resolvable.' },
    stats: { type: 'json', description: 'Per-series summary statistics keyed by series name.' },
    truncated: { type: 'boolean', required: true, description: 'True when rows or series were dropped.' },
    total: { type: 'integer', required: true, description: 'Number of data points this result actually carries.' },
  },
} satisfies ValueSchemaSpec;
