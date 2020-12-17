import { NomicLabsHardhatPluginError } from "hardhat/plugins";
import { CompilerOutputBytecode } from "hardhat/types";

import { pluginName } from "../constants";

import { ContractInformation, ResolvedLinks } from "./bytecode";

export interface Libraries {
  // This may be a fully qualified name
  [libraryName: string]: string;
}

export type LibraryNames = Array<{
  sourceName: string;
  libName: string;
}>;

interface LibrariesStdInput {
  [sourceName: string]: {
    [libraryName: string]: any;
  };
}

export async function getLibraryLinks(
  contractInformation: ContractInformation,
  libraries: Libraries | undefined
) {
  const allLibraries = getLibraryNames(
    contractInformation.contract.evm.bytecode.linkReferences
  );
  const detectableLibraries = getLibraryNames(
    contractInformation.contract.evm.deployedBytecode.linkReferences
  );
  const undetectableLibraries: LibraryNames = allLibraries.filter(
    (lib) =>
      !detectableLibraries.some((detectableLib) => {
        return (
          detectableLib.sourceName === lib.sourceName &&
          detectableLib.libName === lib.libName
        );
      })
  );

  let mergedLibraryLinks = contractInformation.libraryLinks;
  if (libraries !== undefined) {
    const { libraryLinks } = contractInformation;
    // Resolve and normalize library links given by user
    const normalizedLibraries = await normalizeLibraries(
      allLibraries,
      detectableLibraries,
      undetectableLibraries,
      libraries,
      contractInformation.contractName
    );

    // Merge library links
    mergedLibraryLinks = mergeLibraries(normalizedLibraries, libraryLinks);
  }

  const mergedLibraries = getLibraryNames(mergedLibraryLinks);
  if (mergedLibraries.length < allLibraries.length) {
    // TODO: update message to help solve this problem
    const missingLibraries = allLibraries.filter(
      (lib) =>
        !mergedLibraries.some((mergedLib) => {
          return (
            lib.sourceName === mergedLib.sourceName &&
            lib.libName === mergedLib.libName
          );
        })
    );
    const missingLibraryNames = missingLibraries
      .map(({ sourceName, libName }) => `${sourceName}:${libName}`)
      .map((x) => `  * ${x}`)
      .join("\n");
    let message = `The contract ${contractInformation.sourceName}:${contractInformation.contractName} has one or more library references that cannot be detected from deployed bytecode.
This can occur if the library is only called in the contract constructor. The missing libraries are:
${missingLibraryNames}`;
    // We want to distinguish the case when no undetectable libraries were provided to give a more helpful message.
    if (missingLibraries.length === undetectableLibraries.length) {
      message += `

To solve this, you can create a javascript module that exports a library dictionary and pass it through the --libraries parameter:

hardhat verify --libraries libraries.js <other args>

where libraries.js looks like this:

module.exports = {
  SomeLibrary: "0x...",
}

If you are using the "verify:verify" subtask, then you may pass the libraries parameter with such a dictionary directly:

hre.run("verify:verify", {
  <other args>
  libraries: {
    SomeLibrary: "0x...",
  }
}`;
    } else {
      message += `

To solve this, you can add them to your --libraries dictionary with their corresponding addresses.`;
    }
    throw new NomicLabsHardhatPluginError(pluginName, message);
  }
  return { libraryLinks: mergedLibraryLinks, undetectableLibraries };
}

function mergeLibraries(
  normalizedLibraries: ResolvedLinks,
  detectedLibraries: ResolvedLinks
): ResolvedLinks {
  const conflicts = [];
  for (const [sourceName, libraries] of Object.entries(normalizedLibraries)) {
    for (const [libName, libAddress] of Object.entries(libraries)) {
      if (
        sourceName in detectedLibraries &&
        libName in detectedLibraries[sourceName]
      ) {
        const detectedAddress = detectedLibraries[sourceName][libName];
        // Our detection logic encodes bytes into lowercase hex.
        if (libAddress.toLowerCase() !== detectedAddress) {
          conflicts.push({
            library: `${sourceName}:${libName}`,
            detectedAddress,
            inputAddress: libAddress,
          });
        }
      }
    }
  }

  if (conflicts.length > 0) {
    const conflictDescriptions = conflicts
      .map(
        (conflict) =>
          `  * ${conflict.library}
    given address: ${conflict.inputAddress}
    detected address: ${conflict.detectedAddress}`
      )
      .join("\n");
    throw new NomicLabsHardhatPluginError(
      pluginName,
      `The following libraries were detected with a different address than the one provided:
${conflictDescriptions}`
    );
  }

  const mergedLibraries: ResolvedLinks = {};
  addLibraries(mergedLibraries, normalizedLibraries);
  addLibraries(mergedLibraries, detectedLibraries);
  return mergedLibraries;
}

function addLibraries(
  targetLibraries: ResolvedLinks,
  newLibraries: ResolvedLinks
) {
  for (const [sourceName, libraries] of Object.entries(newLibraries)) {
    if (targetLibraries[sourceName] === undefined) {
      targetLibraries[sourceName] = {};
    }
    for (const [libName, libAddress] of Object.entries(libraries)) {
      targetLibraries[sourceName][libName] = libAddress;
    }
  }
}

async function normalizeLibraries(
  allLibraries: LibraryNames,
  detectableLibraries: LibraryNames,
  undetectableLibraries: LibraryNames,
  libraries: Libraries,
  contractName: string
) {
  const { isAddress } = await import("@ethersproject/address");

  const libraryFQNs: Set<string> = new Set();
  const normalizedLibraries: ResolvedLinks = {};
  for (const [linkedLibraryName, linkedLibraryAddress] of Object.entries(
    libraries
  )) {
    if (!isAddress(linkedLibraryAddress)) {
      throw new NomicLabsHardhatPluginError(
        pluginName,
        `You gave a link for the contract ${contractName} with the library ${linkedLibraryName}, but provided this invalid address: ${linkedLibraryAddress}`
      );
    }

    const neededLibrary = lookupLibrary(
      allLibraries,
      detectableLibraries,
      undetectableLibraries,
      linkedLibraryName,
      contractName
    );
    const neededLibraryFQN = `${neededLibrary.sourceName}:${neededLibrary.libName}`;

    // The only way for this library to be already mapped is
    // for it to be given twice in the libraries user input:
    // once as a library name and another as a fully qualified library name.
    if (libraryFQNs.has(neededLibraryFQN)) {
      throw new NomicLabsHardhatPluginError(
        pluginName,
        `The library names ${neededLibrary.libName} and ${neededLibraryFQN} refer to the same library and were given as two separate library links.
Remove one of them and review your library links before proceeding.`
      );
    }

    libraryFQNs.add(neededLibraryFQN);
    if (normalizedLibraries[neededLibrary.sourceName] === undefined) {
      normalizedLibraries[neededLibrary.sourceName] = {};
    }
    normalizedLibraries[neededLibrary.sourceName][
      neededLibrary.libName
    ] = linkedLibraryAddress;
  }
  return normalizedLibraries;
}

function lookupLibrary(
  allLibraries: LibraryNames,
  detectableLibraries: LibraryNames,
  undetectableLibraries: LibraryNames,
  linkedLibraryName: string,
  contractName: string
) {
  const matchingLibraries = allLibraries.filter((lib) => {
    return (
      lib.libName === linkedLibraryName ||
      `${lib.sourceName}:${lib.libName}` === linkedLibraryName
    );
  });

  if (matchingLibraries.length === 0) {
    let detailedMessage = "";
    if (allLibraries.length > 0) {
      const undetectableLibraryFQNames = undetectableLibraries
        .map((lib) => `${lib.sourceName}:${lib.libName}`)
        .map((x) => `  * ${x}`)
        .join("\n");
      const detectableLibraryFQNames = detectableLibraries
        .map((lib) => `${lib.sourceName}:${lib.libName}`)
        .map((x) => `  * ${x} (optional)`)
        .join("\n");
      detailedMessage += `This contract uses the following external libraries:
${undetectableLibraryFQNames}
${detectableLibraryFQNames}`;
    } else {
      detailedMessage += "This contract doesn't use any external libraries.";
    }
    throw new NomicLabsHardhatPluginError(
      pluginName,
      `You gave a link for the library ${linkedLibraryName}, which is not one of the libraries of contract ${contractName}.
${detailedMessage}
Libraries marked as optional don't need to be specified since they are autodetected by the plugin.`
    );
  }

  if (matchingLibraries.length > 1) {
    const matchingLibrariesFQNs = matchingLibraries
      .map(({ sourceName, libName }) => `${sourceName}:${libName}`)
      .map((x) => `  * ${x}`)
      .join("\n");
    throw new NomicLabsHardhatPluginError(
      pluginName,
      `The library name ${linkedLibraryName} is ambiguous for the contract ${contractName}.
It may resolve to one of the following libraries:
${matchingLibrariesFQNs}

To fix this, choose one of these fully qualified library names and replace where appropriate.`
    );
  }

  const [neededLibrary] = matchingLibraries;
  return neededLibrary;
}

function getLibraryNames(libraries: LibrariesStdInput): LibraryNames {
  const libraryNames: LibraryNames = [];
  for (const [sourceName, sourceLibraries] of Object.entries(libraries)) {
    for (const libName of Object.keys(sourceLibraries)) {
      libraryNames.push({ sourceName, libName });
    }
  }

  return libraryNames;
}