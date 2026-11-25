/**
 * End-to-end tests for Vue 2 + Apollo GraphQL monorepo indexing & impact:
 *   1. Cross-file imported constants interpolated inside template strings `${...}`
 *      attributed to enclosing exported functions/constants (and propagating to `.vue`).
 *   2. Apollo BFF GraphQL resolvers ↔ frontend GraphQL query/mutation template strings
 *      (with op-type matching, non-resolver exclusion, and monorepo package disambiguation).
 *   3. Vue `<template lang="pug">` child components & monorepo `@/` (and webpack) aliases.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { extractPugComponentTags } from '../src/extraction/vue-extractor';
import { extractGraphqlOperations, findResolverBlocks } from '../src/resolution/graphql-synthesizer';

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
}

describe('Issue 1: cross-file imported template interpolation references', () => {
  let dir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-issue1-'));
  });
  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('attributes ${importedConst} references to enclosing exported functions/constants and propagates impact to Vue callers', async () => {
    writeTree(dir, {
      'vue/packages/ag-overseas/package.json': JSON.stringify({ name: 'ag-overseas' }),
      'vue/packages/ag-overseas/lib/query/fragment.js': `
export const materialCardListFragment = \`
  id
  title
\`;
export const otherFragment = \`id\`;
`,
      'vue/packages/ag-overseas/lib/query/ai.js': `
import { materialCardListFragment } from './fragment';

export const getAiChatConnect = (operationName = 'aiChatConnect') => ({
  operationName,
  query: \`
    query \${operationName} {
      aiChatConnect {
        material {
          \${materialCardListFragment}
        }
      }
    }
  \`
});
`,
      'vue/packages/ag-overseas/lib/query/leaflet.js': `
import { materialCardListFragment } from './fragment';

export const getLeafletList = (operationName) => ({
  operationName,
  query: \`
    query \${operationName} {
      leafletList {
        \${operationName === 'strict' ? \`total\` : \`
          data {
            material {
              \${materialCardListFragment}
            }
          }
        \`}
      }
    }
  \`
});

export const getMaterialDetailList = () => {
  const defaultBody = \`{ material { \${materialCardListFragment} } }\`;
  return { query: \`query detail \${defaultBody}\` };
};
`,
      'vue/packages/ag-overseas/lib/query/campaign.js': `
import { materialCardListFragment } from './fragment';

export const getAppTimeline = {
  operationName: 'appTimeline',
  query: \`
    query appTimeline {
      appTimeline {
        materialList {
          \${materialCardListFragment}
        }
      }
    }
  \`
};
`,
      'vue/packages/ag-overseas/lib/query/imgSearch.js': `
import { materialCardListFragment } from './fragment';

export const getResourceImgSearchMaterial = {
  operationName: 'resourceImgSearchMaterial',
  query: \`
    query resourceImgSearchMaterial {
      resourceImgSearchMaterial {
        material {
          \${materialCardListFragment}
        }
      }
    }
  \`
};

// Shadowed parameter must NOT emit a reference to the imported constant
export const shadowedFn = (materialCardListFragment) => \`\${materialCardListFragment}\`;
`,
      'vue/packages/ag-overseas/lib/views/ai-chat.vue': `
<template lang="pug">
  div.ai-chat
</template>
<script>
import { getAiChatConnect } from '@/query/ai.js'
export default {
  methods: {
    loadChat() {
      return getAiChatConnect('aiChatConnect')
    }
  }
}
</script>
`,
      'vue/packages/ag-overseas/lib/views/app-timeline.vue': `
<template lang="pug">
  div.timeline
</template>
<script>
import { getAppTimeline } from '@/query/campaign'
export default {
  methods: {
    loadTimeline() {
      return { ...getAppTimeline }
    }
  }
}
</script>
`,
      'vue/packages/ag-overseas/lib/views/similar.vue': `
<template lang="pug">
  div.similar
</template>
<script>
import { getResourceImgSearchMaterial } from '@/query/imgSearch'
export default {
  methods: {
    loadSimilar() {
      return { ...getResourceImgSearchMaterial }
    }
  }
}
</script>
`,
    });

    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();

    const fragNode = cg
      .searchNodes('materialCardListFragment')
      .map((r) => r.node)
      .find((n) => n.name === 'materialCardListFragment' && n.kind === 'constant');
    expect(fragNode).toBeTruthy();

    const incomingNames = cg
      .getIncomingEdges(fragNode!.id)
      .filter((e) => e.kind === 'references')
      .map((e) => cg!.getNode(e.source)?.name);

    expect(incomingNames).toEqual(
      expect.arrayContaining([
        'getAiChatConnect',
        'getLeafletList',
        'getMaterialDetailList',
        'getAppTimeline',
        'getResourceImgSearchMaterial',
      ])
    );
    expect(incomingNames).not.toContain('shadowedFn');

    const impact = cg.getImpactRadius(fragNode!.id, 2);
    const impactedFiles = new Set([...impact.nodes.values()].map((n) => n.filePath));
    expect(impactedFiles).toContain('vue/packages/ag-overseas/lib/query/ai.js');
    expect(impactedFiles).toContain('vue/packages/ag-overseas/lib/query/leaflet.js');
    expect(impactedFiles).toContain('vue/packages/ag-overseas/lib/query/campaign.js');
    expect(impactedFiles).toContain('vue/packages/ag-overseas/lib/query/imgSearch.js');
    expect(impactedFiles).toContain('vue/packages/ag-overseas/lib/views/ai-chat.vue');
    expect(impactedFiles).toContain('vue/packages/ag-overseas/lib/views/app-timeline.vue');
    expect(impactedFiles).toContain('vue/packages/ag-overseas/lib/views/similar.vue');
  });
});

describe('Issue 2: Apollo GraphQL resolver ↔ frontend query template synthesizer', () => {
  let dir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-issue2-'));
  });
  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('extracts root operation fields accurately and ignores nested fields & prose', () => {
    const src = `
export const getChartList = (operationName) => ({
  operationName,
  query: \`
    query \${operationName} ($page: Int!, $area: String!) {
      # comment mentioning fakeField
      freeChartList(page: $page, area: $area) {
        total
        data {
          app { name }
        }
      }
      aliased: aiUserCounts { count }
    }
  \`
});
export const addNote = {
  query: \`mutation createNote($title: String!) { createNote(title: $title) { id } }\`
};
export const prose = \`please query the database for freeChartList\`;
`;
    const ops = extractGraphqlOperations(src, 'campaign.js');
    expect(ops.map((o) => `${o.opType}:${o.fieldName}`)).toEqual([
      'query:freeChartList',
      'query:aiUserCounts',
      'mutation:createNote',
    ]);
  });

  it('detects Query/Mutation blocks and bridges frontend query → BFF resolver → impact to Vue view', async () => {
    const resolverSrc = `
const resolvers = {
  Query: {
    freeChartList: async (parent, args) => {
      const getFreeChartData = async () => [];
      return getFreeChartData();
    },
  },
  Mutation: {
    createNote: async (parent, args) => ({ id: '1' }),
  },
};
module.exports = resolvers;
`;
    const blocks = findResolverBlocks(resolverSrc);
    expect(blocks.map((b) => b.opType)).toEqual(['query', 'mutation']);

    writeTree(dir, {
      'apollo/packages/ag-overseas/package.json': JSON.stringify({ name: 'apollo-ag-overseas' }),
      'apollo/packages/ag-overseas/lib/graphql/schemas/campaign/resolver.js': resolverSrc,
      // Another monorepo package with same resolver name — must NOT be linked to ag-overseas query
      'apollo/packages/other-pkg/package.json': JSON.stringify({ name: 'apollo-other' }),
      'apollo/packages/other-pkg/lib/graphql/schemas/campaign/resolver.js': `
module.exports = {
  Query: {
    freeChartList: async () => [],
  },
};
`,
      // Plain non-resolver JS function with the same name — must NOT be targeted
      'vue/packages/ag-overseas/lib/utils/helpers.js': `
export function freeChartList() { return []; }
export function createNote() { return null; }
`,
      'vue/packages/ag-overseas/package.json': JSON.stringify({ name: 'vue-ag-overseas' }),
      'vue/packages/ag-overseas/lib/query/campaign.js': `
export const getChartList = (operationName) => ({
  operationName,
  query: \`
    query \${operationName} (
      $campaignType: Int!
      $page: Int!
    ) {
      freeChartList(campaignType: $campaignType, page: $page) {
        total
        data { adverts }
      }
    }
  \`
});

// Wrong operation type (mutation calling a Query resolver) must NOT match
export const wrongOp = {
  query: \`mutation { freeChartList { total } }\`
};

// Mutation matching Mutation.createNote
export const submitNote = {
  query: \`mutation createNote($title: String!) { createNote(title: $title) { id } }\`
};
`,
      'vue/packages/ag-overseas/lib/views/chart/list.vue': `
<template lang="pug">
  div.chart-list
</template>
<script>
import { getChartList } from '@/query/campaign'
export default {
  methods: {
    fetchData() {
      return getChartList('freeChartList')
    }
  }
}
</script>
`,
    });

    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();

    const agResolver = cg
      .searchNodes('freeChartList')
      .map((r) => r.node)
      .find(
        (n) =>
          n.name === 'freeChartList' &&
          n.filePath === 'apollo/packages/ag-overseas/lib/graphql/schemas/campaign/resolver.js'
      );
    expect(agResolver).toBeTruthy();

    const impact = cg.getImpactRadius(agResolver!.id, 2);
    const impactedNames = new Set([...impact.nodes.values()].map((n) => n.name));
    const impactedFiles = new Set([...impact.nodes.values()].map((n) => n.filePath));

    expect(impactedNames).toContain('getChartList');
    expect(impactedNames).not.toContain('wrongOp');
    expect(impactedFiles).toContain('vue/packages/ag-overseas/lib/query/campaign.js');
    expect(impactedFiles).toContain('vue/packages/ag-overseas/lib/views/chart/list.vue');

    // Other package's resolver should NOT have an edge from ag-overseas getChartList
    const otherResolver = cg
      .searchNodes('freeChartList')
      .map((r) => r.node)
      .find(
        (n) =>
          n.name === 'freeChartList' &&
          n.filePath === 'apollo/packages/other-pkg/lib/graphql/schemas/campaign/resolver.js'
      );
    expect(otherResolver).toBeTruthy();
    const otherCallers = cg.getCallers(otherResolver!.id).map((c) => c.node.name);
    expect(otherCallers).not.toContain('getChartList');

    // Plain JS helper must NOT receive synthesized graphql-resolver edges
    const plainHelper = cg
      .searchNodes('freeChartList')
      .map((r) => r.node)
      .find((n) => n.filePath === 'vue/packages/ag-overseas/lib/utils/helpers.js');
    expect(plainHelper).toBeTruthy();
    const helperGqlEdges = cg
      .getIncomingEdges(plainHelper!.id)
      .filter((e) => (e.metadata as { synthesizedBy?: string } | undefined)?.synthesizedBy === 'graphql-resolver');
    expect(helperGqlEdges).toHaveLength(0);

    // Mutation resolver is bridged from submitNote
    const createNoteResolver = cg
      .searchNodes('createNote')
      .map((r) => r.node)
      .find((n) => n.filePath === 'apollo/packages/ag-overseas/lib/graphql/schemas/campaign/resolver.js');
    expect(createNoteResolver).toBeTruthy();
    const noteCallers = cg.getCallers(createNoteResolver!.id).map((c) => c.node.name);
    expect(noteCallers).toContain('submitNote');
  });
});

describe('Issue 3: Vue <template lang="pug"> components & monorepo @/ aliases', () => {
  let dir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-issue3-'));
  });
  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('parses Pug tags accurately while skipping multi-line attributes and comments', () => {
    const pug = `
    div.container
        page-title(:word="$t('title')")
        //- commented-out-comp(
            :foo="bar")
        ad-playable(
            v-else-if="propType === 'playable'"
            :is-focus-data="true"
            pop-class="modal-pop"
            @openDetail="openDetail")
        div.wrap: list-update-tip
        pagination(:total="total")
        AdBanner(:show="true")
`;
    const tags = extractPugComponentTags(pug, 1, new Set(['Pagination', 'AdPlayable']));
    const names = tags.map((t) => t.componentName);
    expect(names).toEqual(['PageTitle', 'AdPlayable', 'ListUpdateTip', 'Pagination', 'AdBanner']);
    expect(names).not.toContain('VElseIf');
    expect(names).not.toContain('CommentedOutComp');
    expect(names).not.toContain('PopClass');
  });

  it('links Pug parent pages to child Vue components via monorepo @/ and webpack aliases', async () => {
    writeTree(dir, {
      'vue/vue.config.js': `
const path = require('node:path')
module.exports = {
  chainWebpack: config => {
    config.resolve.alias.set('@components', path.join(__dirname, '/components'))
  }
}
`,
      'vue/components/common-box.vue': `
<template lang="pug">
  div.common-box
</template>
<script>
export default { name: 'CommonBox' }
</script>
`,
      'vue/packages/ag-overseas/package.json': JSON.stringify({ name: 'ag-overseas' }),
      'vue/packages/ag-overseas/lib/components/ad-playable/ad-playable.vue': `
<template lang="pug">
  div.ad-playable
</template>
<script>
export default {
  name: 'AdPlayable',
  methods: {
    openDetail() {}
  }
}
</script>
`,
      'vue/packages/ag-overseas/lib/views/focus/focus.vue': `
<template lang="pug">
  div.ago-focus
    common-box
      ad-playable(
        v-else-if="propType === 'playable'"
        :data="list"
        @openDetail="openPlayableDetail")
</template>
<script>
import AdPlayable from '@/components/ad-playable/ad-playable.vue'
import CommonBox from '@components/common-box.vue'
export default {
  name: 'Focus',
  components: { AdPlayable, CommonBox },
  methods: {
    openPlayableDetail() {}
  }
}
</script>
`,
      'vue/packages/ag-overseas/lib/views/leaflet/playable-ads.vue': `
<template lang="pug">
  div.playable-ads
    ad-playable(
      :data="list"
      @openDetail="openPlayableDetail")
</template>
<script>
import AdPlayable from '@/components/ad-playable/ad-playable.vue'
export default {
  name: 'PlayableAds',
  components: { AdPlayable },
  methods: {
    openPlayableDetail() {}
  }
}
</script>
`,
    });

    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();

    const adPlayable = cg
      .searchNodes('ad-playable')
      .map((r) => r.node)
      .find(
        (n) =>
          n.kind === 'component' &&
          n.filePath === 'vue/packages/ag-overseas/lib/components/ad-playable/ad-playable.vue'
      );
    expect(adPlayable).toBeTruthy();

    const callers = cg.getCallers(adPlayable!.id);
    const callerFiles = new Set(callers.map((c) => c.node.filePath));
    expect(callerFiles).toContain('vue/packages/ag-overseas/lib/views/focus/focus.vue');
    expect(callerFiles).toContain('vue/packages/ag-overseas/lib/views/leaflet/playable-ads.vue');

    const impact = cg.getImpactRadius(adPlayable!.id, 2);
    const impactedFiles = new Set([...impact.nodes.values()].map((n) => n.filePath));
    expect(impactedFiles).toContain('vue/packages/ag-overseas/lib/views/focus/focus.vue');
    expect(impactedFiles).toContain('vue/packages/ag-overseas/lib/views/leaflet/playable-ads.vue');

    // Also verify @components webpack alias resolved CommonBox
    const commonBox = cg
      .searchNodes('common-box')
      .map((r) => r.node)
      .find((n) => n.kind === 'component' && n.filePath === 'vue/components/common-box.vue');
    expect(commonBox).toBeTruthy();
    const boxCallerFiles = new Set(cg.getCallers(commonBox!.id).map((c) => c.node.filePath));
    expect(boxCallerFiles).toContain('vue/packages/ag-overseas/lib/views/focus/focus.vue');
  });
});
