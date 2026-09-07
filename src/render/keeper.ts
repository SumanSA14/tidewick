import {
  Group, Mesh, Object3D, Color,
  CapsuleGeometry, SphereGeometry, BoxGeometry, ConeGeometry,
  type BufferGeometry,
} from 'three'
import { MeshToonNodeMaterial } from 'three/webgpu'
import { makeToonRamp, PROP_RAMP_STOPS } from './materials/toonRamp'
import { KEEPER } from '@/keeper/controller'
import type { KeeperPose } from '@/keeper/animation'

/**
 * The Keeper, drawn.
 *
 * **This is a stand-in and says so.** There is no rigged character and no
 * animation clips in this project, so the figure is assembled from primitives
 * and posed procedurally from `blendedPose()`. It is honest about what it is:
 * a small hooded person with a satchel, readable in silhouette at the distance
 * the follow camera sits, and shaded with the same two-band ramp as the plants
 * so it belongs to the island rather than sitting on top of it.
 *
 * The joint hierarchy is real, though, and that is the point - shoulders and
 * hips are actual pivots. Swapping in a rigged GLB means replacing this file
 * and `poseFor()`, and nothing else in the Keeper stack changes.
 *
 * **On scale.** Every dimension below is a fraction of `KEEPER.height`, so the
 * figure is exactly that tall and changing one number rescales it coherently.
 * The first version hard-coded radii next to a `BODY_HEIGHT` that was itself
 * only 42% of `KEEPER.height`, which drew a character less than half the height
 * it collided at - beside 10-unit plants it read as a dropped bead. Nothing in
 * this world is in metres: the peak is 24 units and a seedling is 10, so the
 * Keeper is sized against the island, not against a person.
 */

/** Total height of the figure, in world units. */
const H = KEEPER.height

export interface KeeperColors {
  cloak: number
  skin: number
  satchel: number
  lantern: number
  hood: number
}

const DEFAULT_COLORS: KeeperColors = {
  cloak: 0xd8674f,
  skin: 0xf0c9a4,
  satchel: 0x8a6a4a,
  lantern: 0xffd98a,
  hood: 0xd8674f,
}

/**
 * The three colours the founding flow asks for, as stored on `meta.keeper`.
 * Section 4 calls the Keeper "user-named and dressed"; until this existed the
 * choice was saved and never worn.
 */
export interface KeeperDressing {
  body: string
  hair: string
  outfit: string
}

/** Where the hips sit. Everything above swings from here. */
const HIP_Y = H * 0.44
const LEG_LENGTH = H * 0.40
const ARM_LENGTH = H * 0.34
const SHOULDER_Y = H * 0.80
const LIMB_RADIUS = H * 0.052

export class KeeperView {
  readonly group = new Group()

  private readonly root = new Group()
  private readonly torso = new Group()
  private readonly leftArm = new Group()
  private readonly rightArm = new Group()
  private readonly leftLeg = new Group()
  private readonly rightLeg = new Group()
  private readonly carried = new Group()
  private readonly disposables: Array<BufferGeometry | MeshToonNodeMaterial> = []
  private materials!: Record<keyof KeeperColors, MeshToonNodeMaterial>

  constructor(colors: Partial<KeeperColors> = {}) {
    const palette = { ...DEFAULT_COLORS, ...colors }
    const ramp = makeToonRamp(PROP_RAMP_STOPS)

    const material = (hex: number) => {
      const m = new MeshToonNodeMaterial({ color: new Color(hex), gradientMap: ramp })
      this.disposables.push(m)
      return m
    }
    const cloak = material(palette.cloak)
    const skin = material(palette.skin)
    const satchel = material(palette.satchel)
    const lantern = material(palette.lantern)
    // The hood gets its own material: the founding flow lets the player pick a
    // hair colour, and on a hooded figure the hood is where hair would show.
    const hood = material(palette.hood)
    this.materials = { cloak, skin, satchel, lantern, hood }

    const add = (parent: Object3D, geo: BufferGeometry, mat: MeshToonNodeMaterial) => {
      this.disposables.push(geo)
      const mesh = new Mesh(geo, mat)
      mesh.castShadow = true
      // The Keeper does not receive shadow: at this scale a self-shadow on a
      // primitive body reads as dirt, not as form.
      parent.add(mesh)
      return mesh
    }

    // --- torso ---------------------------------------------------------------
    // A cloak that widens toward the hem, so the silhouette is a bell rather
    // than a tube - that shape is most of what makes it read as a person in a
    // cloak from thirty units away.
    const body = add(this.torso, new ConeGeometry(H * 0.20, H * 0.46, 10), cloak)
    body.position.y = HIP_Y + H * 0.15

    const shoulders = add(this.torso, new SphereGeometry(H * 0.15, 12, 10), cloak)
    shoulders.position.y = SHOULDER_Y

    const head = add(this.torso, new SphereGeometry(H * 0.10, 12, 10), skin)
    head.position.set(0, H * 0.885, H * 0.02)

    // The hood is the reading of the character: a cone over the head.
    const hoodMesh = add(this.torso, new ConeGeometry(H * 0.155, H * 0.24, 10), hood)
    hoodMesh.position.y = H * 0.90
    hoodMesh.rotation.x = -0.10

    const bag = add(this.torso, new BoxGeometry(H * 0.15, H * 0.13, H * 0.08), satchel)
    bag.position.set(H * 0.16, HIP_Y + H * 0.10, -H * 0.07)
    bag.rotation.z = 0.2

    // --- limbs ---------------------------------------------------------------
    // Each limb group sits at its joint and the mesh hangs below it, so
    // rotating the group swings from the shoulder or hip rather than about the
    // limb's own centre.
    const limb = (parent: Object3D, length: number) => {
      const mesh = add(parent, new CapsuleGeometry(LIMB_RADIUS, length, 3, 8), cloak)
      mesh.position.y = -length * 0.5
      return mesh
    }

    this.leftArm.position.set(-H * 0.155, SHOULDER_Y, 0)
    this.rightArm.position.set(H * 0.155, SHOULDER_Y, 0)
    limb(this.leftArm, ARM_LENGTH)
    limb(this.rightArm, ARM_LENGTH)

    this.leftLeg.position.set(-H * 0.075, HIP_Y, 0)
    this.rightLeg.position.set(H * 0.075, HIP_Y, 0)
    limb(this.leftLeg, LEG_LENGTH)
    limb(this.rightLeg, LEG_LENGTH)

    this.torso.add(this.leftArm, this.rightArm, this.leftLeg, this.rightLeg)

    // What the Keeper is carrying, held out in front of the chest.
    add(this.carried, new SphereGeometry(H * 0.13, 10, 8), lantern)
    this.carried.position.set(0, SHOULDER_Y - H * 0.10, H * 0.22)
    this.carried.visible = false
    this.torso.add(this.carried)

    this.root.add(this.torso)
    this.group.add(this.root)
    this.group.name = 'keeper'
  }

  /**
   * Drive the figure from a pose.
   *
   * Called every rendered frame with the blended pose, so it must not allocate
   * and must not branch on animation state - the state machine already resolved
   * that, and duplicating the decision here is how the two drift apart.
   */
  apply(
    x: number,
    y: number,
    z: number,
    yaw: number,
    pose: KeeperPose,
    carrying: boolean,
  ): void {
    this.group.position.set(x, y, z)
    this.group.rotation.y = yaw

    // Crouch settles the whole figure rather than sinking it through the floor.
    const settle = pose.crouch * H * 0.22
    this.root.position.y = pose.bob * H * 0.3 - settle
    this.torso.rotation.x = pose.lean + pose.crouch * 0.45

    // Arms oppose legs; that opposition is most of what makes a walk read.
    const hold = pose.hold
    const swing = pose.armSwing * (1 - hold)
    this.leftArm.rotation.x = swing - hold * 1.15
    this.rightArm.rotation.x = -swing - hold * 1.15
    // Elbows out a little when holding something, so the load looks held
    // rather than stuck to the chest.
    this.leftArm.rotation.z = hold * 0.28
    this.rightArm.rotation.z = -hold * 0.28

    this.leftLeg.rotation.x = pose.legSwing
    this.rightLeg.rotation.x = -pose.legSwing

    this.carried.visible = carrying
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible
  }

  /**
   * Wear the colours the player chose.
   *
   * Outfit is the cloak, body is the skin, and hair tints the hood - a hooded
   * figure has nowhere else to show it. Colours arrive as CSS hex strings
   * straight from the swatches; anything unparseable is ignored rather than
   * turning the Keeper black.
   */
  dress(colours: Partial<KeeperDressing>): void {
    const apply = (material: MeshToonNodeMaterial, hex: string | undefined) => {
      if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return
      material.color.set(hex)
    }
    apply(this.materials.cloak, colours.outfit)
    apply(this.materials.skin, colours.body)
    apply(this.materials.hood, colours.hair)
  }

  dispose(): void {
    for (const item of this.disposables) item.dispose()
    this.disposables.length = 0
    this.group.clear()
  }
}
